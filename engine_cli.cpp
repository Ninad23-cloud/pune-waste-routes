// engine_cli.cpp
// Runs the planner from the command line, no web server needed.
// Handy for testing the algorithms and for checking numbers in your report.
//
//   engine_cli towns
//   engine_cli plan <seed> <thr> <cap> <algo> [pretty]
//     example: engine_cli plan 1 50 8 sav2 pretty
#include <cstdlib>
#include <iostream>
#include <string>

#include "engine.hpp"

int main(int argc, char** argv) {
    try {
        waste::Engine engine;
        std::string cmd = argc > 1 ? argv[1] : "";
        if (cmd == "towns") {
            std::cout << engine.towns().dump() << "\n";
            return 0;
        }
        if (cmd == "plan" && argc >= 6) {
            bool pretty = argc > 6 && std::string(argv[6]) == "pretty";
            auto j = engine.plan(std::stoi(argv[2]), std::stoi(argv[3]), std::stod(argv[4]), argv[5]);
            std::cout << (pretty ? j.dump(2) : j.dump()) << "\n";
            return 0;
        }
        std::cerr << "usage:\n  engine_cli towns\n  engine_cli plan <seed> <thr> <cap> <algo> [pretty]\n"
                     "  algo is one of: nn, nn2, sav, sav2\n";
        return 2;
    } catch (const std::exception& e) {
        std::cerr << "error: " << e.what() << "\n";
        return 1;
    }
}
