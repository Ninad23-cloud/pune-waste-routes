// engine.hpp
// All the DAA logic for the Pune district waste-collection planner.
// No networking in this file, so it can be tested on its own (see engine_cli.cpp).
//
//   Graph (adjacency list)  ->  Dijkstra with a binary min-heap  ->  distance matrix D
//   select stops by fill level
//   build routes:   Nearest Neighbor   |   Clarke-Wright Savings
//   improve routes: 2-opt local search
//
// Complexities (n = stops to visit, V = towns, E = road links):
//   Dijkstra (heap)        O((V+E) log V) per source, run once per source
//   Nearest Neighbor       O(n^2)
//   Savings                O(n^2 log n)   (sorting the n(n-1)/2 savings dominates)
//   2-opt                  O(n^2) per pass
#pragma once

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <functional>
#include <limits>
#include <map>
#include <numeric>
#include <queue>
#include <set>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

#include "json.hpp"

namespace waste {

using json = nlohmann::json;
using Routes = std::vector<std::vector<int>>;

constexpr double TONNES_PER_BIN = 0.25;  // tonnes held by one full bin
constexpr double SPEED_KMH = 38.0;       // average truck speed
constexpr double STOP_MIN = 10.0;        // minutes spent at each stop
constexpr double ROAD_FACTOR = 1.25;     // road length = straight line * this
constexpr double INF = std::numeric_limits<double>::infinity();
constexpr double PI = 3.14159265358979323846;

struct Town {
    std::string name;
    double lat, lon;
    int bins;           // number of bins in the town (0 for the depot)
    bool depot;
    std::string label;  // where the front end puts the name: l, r, t, b
    std::string note;
    double capT() const { return bins * TONNES_PER_BIN; }
};

struct Row {
    std::vector<int> nodes;  // town indices in visiting order (depot excluded)
    double km = 0, load = 0, hours = 0;
};

struct Stats {
    std::vector<Row> rows;
    double km = 0, hours = 0;
    int trucks = 0;
};

// Small seeded random generator (mulberry32), so every run of "day N" gives the same fill levels.
class Mulberry {
    uint32_t a_;
public:
    explicit Mulberry(uint32_t seed) : a_(seed) {}
    double next() {
        a_ += 0x6D2B79F5u;
        uint32_t t = (a_ ^ (a_ >> 15)) * (1u | a_);
        t = (t + ((t ^ (t >> 7)) * (61u | t))) ^ t;
        return static_cast<double>(t ^ (t >> 14)) / 4294967296.0;
    }
};

class Engine {
public:
    Engine() {
        initTowns();
        N_ = static_cast<int>(T_.size());
        adj_.assign(N_, {});
        buildGraph();
        allPairs();
        initAlgos();
    }

    // Static data the page needs once: towns, road links, algorithm list.
    json towns() const {
        json arr = json::array();
        for (int i = 0; i < N_; ++i) {
            const Town& t = T_[i];
            arr.push_back({{"id", i}, {"name", t.name}, {"lat", t.lat}, {"lon", t.lon},
                           {"bins", t.bins}, {"capT", t.capT()}, {"note", t.note},
                           {"depot", t.depot}, {"label", t.label}});
        }
        json edges = json::array();
        for (const Edge& e : edges_) edges.push_back(json::array({e.a, e.b, e.w}));
        json algos = json::array();
        for (const AlgoDef& a : algos_) algos.push_back({{"id", a.id}, {"name", a.name}});
        return {{"towns", arr},
                {"edges", edges},
                {"algos", algos},
                {"constants", {{"tonnesPerBin", TONNES_PER_BIN}, {"speedKmh", SPEED_KMH},
                               {"stopMinutes", STOP_MIN}, {"roadFactor", ROAD_FACTOR}}}};
    }

    // One day's plan. Runs every algorithm so the page can compare them.
    json plan(int seed, int thr, double cap, const std::string& algoId) const {
        if (seed < 1 || seed > 1000000) throw std::invalid_argument("seed must be 1..1000000");
        if (thr < 0 || thr > 100) throw std::invalid_argument("thr must be 0..100");
        if (!(cap >= 1.0 && cap <= 100.0)) throw std::invalid_argument("cap must be 1..100");
        const AlgoDef* chosen = nullptr;
        for (const AlgoDef& a : algos_) if (a.id == algoId) chosen = &a;
        if (!chosen) throw std::invalid_argument("unknown algo '" + algoId + "'");

        auto t0 = std::chrono::steady_clock::now();

        std::vector<int> fills = fillsFor(seed);
        std::vector<double> q(N_, 0.0);
        std::vector<int> ids, all;
        for (int i = 1; i < N_; ++i) {
            q[i] = T_[i].capT() * fills[i] / 100.0;
            all.push_back(i);
            if (fills[i] >= thr) ids.push_back(i);
        }

        json results = json::object();
        for (const AlgoDef& a : algos_)
            results[a.id] = statsJson(stats(a.fn(ids, q, cap), q));

        Stats base = stats(chosen->fn(all, q, cap), q);  // same method, every town collected

        double ms = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - t0).count();
        return {{"params", {{"seed", seed}, {"thr", thr}, {"cap", cap}, {"algo", algoId}}},
                {"fills", fills},
                {"q", q},
                {"collected", ids},
                {"results", results},
                {"baseline", {{"km", base.km}, {"hours", base.hours}, {"trucks", base.trucks}}},
                {"computeMs", ms}};
    }

private:
    struct Edge { int a, b; double w; };
    struct AlgoDef {
        std::string id, name;
        std::function<Routes(const std::vector<int>&, const std::vector<double>&, double)> fn;
    };

    std::vector<Town> T_;
    int N_ = 0;
    std::vector<Edge> edges_;
    std::vector<std::vector<std::pair<int, double>>> adj_;
    std::vector<std::vector<double>> D_;   // D_[i][j] = shortest road km from i to j
    std::vector<std::vector<int>> prev_;   // prev_[s][v] = node before v on the path from s
    std::vector<AlgoDef> algos_;

    // ---------- data ----------
    void initTowns() {
        // Pune district: the two big urban centres plus the main town of each taluka.
        // Positions are approximate; bin counts are demo values (the two cities have the most bins).
        T_ = {
            {"Central yard (Hadapsar)", 18.490, 73.960, 0, true, "r", "Depot"},
            {"Pune", 18.520, 73.856, 30, false, "b", "Pune Municipal Corporation area"},
            {"Pimpri-Chinchwad", 18.629, 73.799, 24, false, "r", "Industrial city"},
            {"Vadgaon Maval", 18.760, 73.650, 6, false, "t", "Maval taluka"},
            {"Paud", 18.510, 73.620, 6, false, "r", "Mulshi taluka"},
            {"Rajgurunagar", 18.863, 73.887, 7, false, "r", "Khed taluka"},
            {"Manchar", 19.003, 73.943, 5, false, "r", "Ambegaon taluka"},
            {"Junnar", 19.209, 73.875, 8, false, "r", "Junnar taluka"},
            {"Shirur", 18.827, 74.376, 9, false, "r", "Shirur taluka"},
            {"Daund", 18.466, 74.583, 8, false, "r", "Daund taluka"},
            {"Baramati", 18.151, 74.577, 12, false, "t", "Baramati taluka"},
            {"Indapur", 18.116, 75.019, 7, false, "l", "Indapur taluka"},
            {"Saswad", 18.348, 74.034, 8, false, "r", "Purandar taluka"},
            {"Bhor", 18.150, 73.846, 5, false, "r", "Bhor taluka"},
            {"Velhe", 18.287, 73.620, 3, false, "r", "Velhe taluka"},
        };
    }

    // ---------- graph ----------
    static double hav(const Town& a, const Town& b) {
        const double r = PI / 180.0;
        double dl = (b.lat - a.lat) * r, dn = (b.lon - a.lon) * r;
        double h = std::sin(dl / 2) * std::sin(dl / 2) +
                   std::cos(a.lat * r) * std::cos(b.lat * r) * std::sin(dn / 2) * std::sin(dn / 2);
        return 2 * 6371.0 * std::asin(std::sqrt(h));
    }

    // Each town is joined to its 3 nearest neighbours; Union-Find then adds the
    // shortest extra links needed to make the whole network connected.
    void buildGraph() {
        std::vector<int> parent(N_);
        std::iota(parent.begin(), parent.end(), 0);
        auto find = [&](int x) {
            while (parent[x] != x) { parent[x] = parent[parent[x]]; x = parent[x]; }
            return x;
        };
        std::set<std::pair<int, int>> seen;
        auto add = [&](int a, int b) {
            if (!seen.insert({std::min(a, b), std::max(a, b)}).second) return;
            double w = hav(T_[a], T_[b]) * ROAD_FACTOR;
            edges_.push_back({a, b, w});
            adj_[a].push_back({b, w});
            adj_[b].push_back({a, w});
            parent[find(a)] = find(b);
        };
        for (int i = 0; i < N_; ++i) {
            std::vector<std::pair<int, double>> near;
            for (int j = 0; j < N_; ++j) if (j != i) near.push_back({j, hav(T_[i], T_[j])});
            std::stable_sort(near.begin(), near.end(),
                             [](const auto& x, const auto& y) { return x.second < y.second; });
            for (int k = 0; k < 3; ++k) add(i, near[k].first);
        }
        struct Cand { int i, j; double d; };
        std::vector<Cand> all;
        for (int i = 0; i < N_; ++i)
            for (int j = i + 1; j < N_; ++j) all.push_back({i, j, hav(T_[i], T_[j])});
        std::stable_sort(all.begin(), all.end(), [](const Cand& x, const Cand& y) { return x.d < y.d; });
        for (const Cand& c : all) if (find(c.i) != find(c.j)) add(c.i, c.j);
    }

    // Dijkstra with a binary min-heap (std::priority_queue).
    void dijkstra(int src, std::vector<double>& dist, std::vector<int>& prv) const {
        dist.assign(N_, INF);
        prv.assign(N_, -1);
        using P = std::pair<double, int>;
        std::priority_queue<P, std::vector<P>, std::greater<P>> pq;
        dist[src] = 0;
        pq.push({0.0, src});
        while (!pq.empty()) {
            auto [d, u] = pq.top();
            pq.pop();
            if (d > dist[u]) continue;  // stale heap entry
            for (const auto& [v, w] : adj_[u]) {
                if (d + w < dist[v]) {
                    dist[v] = d + w;
                    prv[v] = u;
                    pq.push({dist[v], v});
                }
            }
        }
    }

    void allPairs() {
        D_.assign(N_, {});
        prev_.assign(N_, {});
        for (int s = 0; s < N_; ++s) dijkstra(s, D_[s], prev_[s]);
    }

    std::vector<int> pathBetween(int a, int b) const {
        std::vector<int> p{b};
        while (p.back() != a) p.push_back(prev_[a][p.back()]);
        std::reverse(p.begin(), p.end());
        return p;
    }

    // Road-node sequence for one truck: yard -> stops -> yard, following real links.
    std::vector<int> fullPath(const std::vector<int>& nodes) const {
        std::vector<int> seq{0};
        seq.insert(seq.end(), nodes.begin(), nodes.end());
        seq.push_back(0);
        std::vector<int> pts;
        for (size_t a = 0; a + 1 < seq.size(); ++a) {
            std::vector<int> seg = pathBetween(seq[a], seq[a + 1]);
            if (a > 0) seg.erase(seg.begin());
            pts.insert(pts.end(), seg.begin(), seg.end());
        }
        return pts;
    }

    // ---------- routing ----------
    double routeKm(const std::vector<int>& r) const {
        if (r.empty()) return 0;
        double d = D_[0][r.front()];
        for (size_t i = 0; i + 1 < r.size(); ++i) d += D_[r[i]][r[i + 1]];
        return d + D_[r.back()][0];
    }

    // Greedy: from the current stop go to the nearest unvisited town that still fits in the truck.
    Routes nearestNeighbor(std::vector<int> left, const std::vector<double>& q, double cap) const {
        Routes routes;
        while (!left.empty()) {
            int cur = 0;
            double load = 0;
            std::vector<int> r;
            for (;;) {
                int best = -1;
                double bd = INF;
                for (size_t idx = 0; idx < left.size(); ++idx) {
                    int j = left[idx];
                    if (load + q[j] <= cap + 1e-9 && D_[cur][j] < bd) { bd = D_[cur][j]; best = static_cast<int>(idx); }
                }
                if (best < 0) break;
                int pick = left[best];
                left.erase(left.begin() + best);
                r.push_back(pick);
                load += q[pick];
                cur = pick;
            }
            if (r.empty()) { r.push_back(left.front()); left.erase(left.begin()); }
            routes.push_back(r);
        }
        return routes;
    }

    // Clarke-Wright: start with one truck per town, then merge routes in order of biggest saving
    // s(i,j) = D[yard][i] + D[yard][j] - D[i][j], as long as the truck can carry the combined load.
    Routes savings(const std::vector<int>& ids, const std::vector<double>& q, double cap) const {
        struct Rt { std::vector<int> nodes; double load; };
        std::map<int, Rt> routes;
        std::vector<int> rid(N_, -1);
        for (size_t n = 0; n < ids.size(); ++n) {
            routes[static_cast<int>(n)] = Rt{{ids[n]}, q[ids[n]]};
            rid[ids[n]] = static_cast<int>(n);
        }
        struct Pair { int i, j; double s; };
        std::vector<Pair> pairs;
        for (size_t a = 0; a < ids.size(); ++a)
            for (size_t b = a + 1; b < ids.size(); ++b) {
                int i = ids[a], j = ids[b];
                pairs.push_back({i, j, D_[0][i] + D_[0][j] - D_[i][j]});
            }
        std::stable_sort(pairs.begin(), pairs.end(), [](const Pair& x, const Pair& y) { return x.s > y.s; });
        for (const Pair& p : pairs) {
            int ra = rid[p.i], rb = rid[p.j];
            if (ra == rb) continue;
            if (routes[ra].load + routes[rb].load > cap + 1e-9) continue;
            std::vector<int> An = routes[ra].nodes, Bn = routes[rb].nodes;
            // i must be at the end of its route and j at the start of its route
            if (An.back() != p.i) { if (An.front() == p.i) std::reverse(An.begin(), An.end()); else continue; }
            if (Bn.front() != p.j) { if (Bn.back() == p.j) std::reverse(Bn.begin(), Bn.end()); else continue; }
            Rt merged{An, routes[ra].load + routes[rb].load};
            merged.nodes.insert(merged.nodes.end(), Bn.begin(), Bn.end());
            routes.erase(rb);
            routes[ra] = merged;
            for (int n : routes[ra].nodes) rid[n] = ra;
        }
        Routes out;
        for (const auto& kv : routes) out.push_back(kv.second.nodes);
        return out;
    }

    // 2-opt: reverse a segment whenever that makes the route shorter, until nothing improves.
    std::vector<int> twoOpt(const std::vector<int>& r) const {
        std::vector<int> route{0};
        route.insert(route.end(), r.begin(), r.end());
        route.push_back(0);
        bool improved = true;
        while (improved) {
            improved = false;
            for (size_t i = 1; i + 2 < route.size(); ++i)
                for (size_t j = i + 1; j + 1 < route.size(); ++j) {
                    int a = route[i - 1], b = route[i], c = route[j], d = route[j + 1];
                    if (D_[a][c] + D_[b][d] - D_[a][b] - D_[c][d] < -1e-9) {
                        std::reverse(route.begin() + i, route.begin() + j + 1);
                        improved = true;
                    }
                }
        }
        return std::vector<int>(route.begin() + 1, route.end() - 1);
    }

    void initAlgos() {
        auto improve = [this](Routes rs) { for (auto& r : rs) r = twoOpt(r); return rs; };
        algos_ = {
            {"nn", "Nearest Neighbor",
             [this](const std::vector<int>& i, const std::vector<double>& q, double c) { return nearestNeighbor(i, q, c); }},
            {"nn2", "Nearest Neighbor + 2-opt",
             [this, improve](const std::vector<int>& i, const std::vector<double>& q, double c) { return improve(nearestNeighbor(i, q, c)); }},
            {"sav", "Clarke-Wright Savings",
             [this](const std::vector<int>& i, const std::vector<double>& q, double c) { return savings(i, q, c); }},
            {"sav2", "Savings + 2-opt",
             [this, improve](const std::vector<int>& i, const std::vector<double>& q, double c) { return improve(savings(i, q, c)); }},
        };
    }

    Stats stats(const Routes& routes, const std::vector<double>& q) const {
        Stats s;
        int stops = 0;
        for (const auto& r : routes) {
            Row row;
            row.nodes = r;
            row.km = routeKm(r);
            for (int n : r) row.load += q[n];
            row.hours = row.km / SPEED_KMH + r.size() * STOP_MIN / 60.0;
            s.km += row.km;
            stops += static_cast<int>(r.size());
            s.rows.push_back(row);
        }
        s.trucks = static_cast<int>(routes.size());
        s.hours = s.km / SPEED_KMH + stops * STOP_MIN / 60.0;
        return s;
    }

    json statsJson(const Stats& s) const {
        json rows = json::array();
        for (const Row& r : s.rows)
            rows.push_back({{"nodes", r.nodes}, {"path", fullPath(r.nodes)},
                            {"km", r.km}, {"load", r.load}, {"hours", r.hours}});
        return {{"trucks", s.trucks}, {"km", s.km}, {"hours", s.hours}, {"rows", rows}};
    }

    // ---------- daily fill levels ----------
    std::vector<int> fillsFor(int seed) const {
        Mulberry rnd(static_cast<uint32_t>(seed) * 7919u + 13u);
        std::vector<int> f(N_, 0);
        for (int i = 0; i < N_; ++i)
            f[i] = T_[i].depot ? 0 : static_cast<int>(std::floor(15 + rnd.next() * 80 + 0.5));
        return f;
    }
};

}  // namespace waste
