// main.cpp
// Local web server: serves the page from ./public and exposes the planner as a small REST API.
//
//   GET /api/health
//   GET /api/towns
//   GET /api/plan?seed=1&thr=50&cap=8&algo=sav2
//
// The page and the API come from the same address, so the browser needs no CORS setup.
#include <cstdlib>
#include <iostream>
#include <string>

#include "httplib.h"  // cpp-httplib, single header, see README
#include "engine.hpp"

namespace {

int intParam(const httplib::Request& req, const char* key, int fallback) {
    return req.has_param(key) ? std::stoi(req.get_param_value(key)) : fallback;
}

double numParam(const httplib::Request& req, const char* key, double fallback) {
    return req.has_param(key) ? std::stod(req.get_param_value(key)) : fallback;
}

void sendJson(httplib::Response& res, int status, const waste::json& body) {
    res.status = status;
    res.set_content(body.dump(), "application/json");
}

}  // namespace

int main(int argc, char** argv) {
    int port = argc > 1 ? std::atoi(argv[1]) : 8080;
    std::string publicDir = argc > 2 ? argv[2] : "public";

    waste::Engine engine;
    httplib::Server svr;

    // Lets the page also work when opened from another origin (for example VS Code Live Server).
    svr.set_default_headers({{"Access-Control-Allow-Origin", "*"}});

    if (!svr.set_mount_point("/", publicDir)) {
        std::cerr << "Warning: folder '" << publicDir << "' not found. Run the server from the project folder,\n"
                  << "or pass the path:  server 8080 /path/to/public\n";
    }

    svr.Get("/api/health", [](const httplib::Request&, httplib::Response& res) {
        sendJson(res, 200, {{"status", "ok"}});
    });

    svr.Get("/api/towns", [&engine](const httplib::Request&, httplib::Response& res) {
        sendJson(res, 200, engine.towns());
    });

    svr.Get("/api/plan", [&engine](const httplib::Request& req, httplib::Response& res) {
        try {
            int seed = intParam(req, "seed", 1);
            int thr = intParam(req, "thr", 50);
            double cap = numParam(req, "cap", 8);
            std::string algo = req.has_param("algo") ? req.get_param_value("algo") : "sav2";
            sendJson(res, 200, engine.plan(seed, thr, cap, algo));
        } catch (const std::exception& e) {
            sendJson(res, 400, {{"error", e.what()}});
        }
    });

    std::cout << "Pune waste planner running.\n"
              << "Open http://localhost:" << port << " in your browser. Press Ctrl+C to stop.\n";
    // Use "0.0.0.0" instead of "127.0.0.1" to let other devices on your network open it too.
    if (!svr.listen("0.0.0.0", port)) {
        std::cerr << "Could not start on port " << port << ". Is another program using it? Try: server 8081\n";
        return 1;
    }
    return 0;
}
