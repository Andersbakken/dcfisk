#include "Client.h"
#include "CompilerArgs.h"
#include "Config.h"
#include "SlaveWebSocket.h"
#include "SchedulerWebSocket.h"
#include "Log.h"
#include "Select.h"
#include "Watchdog.h"
#include "WebSocket.h"
#include <json11.hpp>
#include <climits>
#include <cstdlib>
#include <cstring>
#include <unistd.h>
#include <csignal>

static const unsigned long long milliseconds_since_epoch = std::chrono::system_clock::now().time_since_epoch() / std::chrono::milliseconds(1);
static unsigned long long preprocessedDuration = 0;
static unsigned long long preprocessedSlotDuration = 0;
int main(int argcIn, char **argvIn)
{
    // usleep(500 * 1000);
    // return 0;
    std::atexit([]() {
            for (sem_t *semaphore : Client::data().semaphores) {
                sem_post(semaphore);
            }
            if (Watchdog *watchdog = Client::data().watchdog) {
                if (Log::minLogLevel <= Log::Warn) {
                    std::string str = Client::format("since epoch: %llu preprocess time: %llu (slot time: %llu)",
                                                     milliseconds_since_epoch, preprocessedDuration, preprocessedSlotDuration);
                    for (size_t i=Watchdog::ConnectedToScheduler; i<=Watchdog::Finished; ++i) {
                        str += Client::format(" %s: %llu (%llu)", Watchdog::stageName(static_cast<Watchdog::Stage>(i)),
                                              watchdog->timings[i] - watchdog->timings[i - 1],
                                              watchdog->timings[i] - Client::started);
                    }
                    Log::log(Log::Warn, str);
                }
            }
        });

    Config::init();
    std::string logLevel = Config::logLevel();
    std::string logFile = Config::logFile();
    const char *env;
    if ((env = getenv("FISK_LOG"))) {
        logLevel = env;
    } else if ((env = getenv("FISK_DEBUG"))) {
        logLevel = env;
    } else if ((env = getenv("FISK_VERBOSE"))) {
        if (!*env || !strcmp(env, "1")) {
            logLevel = "Debug";
        }
    }

    if ((env = getenv("FISK_LOG_FILE"))) {
        logFile = env;
    }

    Log::LogFileMode logFileMode = Log::Overwrite;
    if ((env = getenv("FISK_LOG_APPEND"))) {
        logFileMode = Log::Append;
    }

    bool disabled = false;
    if ((env = getenv("FISK_DISABLED"))) {
        disabled = !strlen(env) || !strcmp(env, "1");
    }

    const char *preresolved = getenv("FISK_COMPILER");
    const char *slave = getenv("FISK_SLAVE");

    Watchdog watchdog;
    Client::Data &data = Client::data();
    data.watchdog = &watchdog;
    auto signalHandler = [](int) { exit(1); };
    for (int signal : { SIGINT, SIGHUP, SIGQUIT, SIGILL, SIGABRT, SIGFPE, SIGSEGV, SIGALRM, SIGTERM }) {
        std::signal(signal, signalHandler);
    }
    data.argv = new char *[argcIn + 1];
    for (int i=0; i<argcIn; ++i) {
        if (!strncmp("--fisk-log-level=", argvIn[i], 17)
            || !strncmp("--fisk-log=", argvIn[i], 11)
            || !strncmp("--fisk-debug-level=", argvIn[i], 19)
            || !strncmp("--fisk-debug=", argvIn[i], 13)) {
            logLevel = strchr(argvIn[i], '=') + 1;
        } else if (i + 1 < argcIn && (!strcmp("--fisk-log-level", argvIn[i])
                                      || !strcmp("--fisk-log-level", argvIn[i])
                                      || !strcmp("--fisk-log", argvIn[i])
                                      || !strcmp("--fisk-debug", argvIn[i]))) {
            logLevel = argvIn[++i];
        } else if (!strncmp("--fisk-log-file=", argvIn[i], 16)) {
            logFile = argvIn[i] + 16;
        } else if (i + 1 < argcIn && !strcmp("--fisk-log-file", argvIn[i])) {
            logFile = argvIn[++i];
        } else if (!strncmp("--fisk-compiler=", argvIn[i], 16)) {
            preresolved = argvIn[i] + 16;
        } else if (i + 1 < argcIn && !strcmp("--fisk-compiler", argvIn[i])) {
            preresolved = argvIn[++i];
        } else if (!strncmp("--fisk-slave=", argvIn[i], 13)) {
            slave = argvIn[i] + 13;
        } else if (i + 1 < argcIn && !strcmp("--fisk-slave", argvIn[i])) {
            slave = argvIn[++i];
        } else if (!strcmp("--fisk-disabled", argvIn[i])) {
            disabled = true;
        } else if (!strcmp("--fisk-clean-semaphores", argvIn[i])) {
            for (Client::Slot::Type type : { Client::Slot::Compile, Client::Slot::Cpp }) {
                if (sem_unlink(Client::Slot::typeToString(type))) {
                    fprintf(stderr, "Failed to unlink semaphore %s: %d %s\n",
                            Client::Slot::typeToString(type), errno, strerror(errno));
                }
            }
            return 0;
        } else if (!strcmp("--fisk-dump-semaphores", argvIn[i])) {
            for (Client::Slot::Type type : { Client::Slot::Compile, Client::Slot::Cpp }) {
                sem_t *sem = sem_open(Client::Slot::typeToString(type), O_CREAT, 0666, Client::Slot::slots(type));
                if (!sem) {
                    fprintf(stderr, "Failed to open semaphore %s slots: %zu: %d %s\n",
                            Client::Slot::typeToString(type), Client::Slot::slots(type),
                            errno, strerror(errno));
                    continue;
                }
                int val = -1;
                sem_getvalue(sem, &val);
                printf("%s %d/%zu\n", Client::Slot::typeToString(type), val, Client::Slot::slots(type));
                sem_close(sem);
            }

            return 0;
        } else {
            data.argv[data.argc++] = argvIn[i];
        }
    }
    Log::Level level = Log::Silent;
    if (!logLevel.empty()) {
        bool ok;
        level = Log::stringToLevel(logLevel.c_str(), &ok);
        if (!ok) {
            fprintf(stderr, "Invalid log level: %s (\"Debug\", \"Warn\", \"Error\" or \"Silent\")\n", logLevel.c_str());
            return 1;
        }
    }

    Log::init(level, std::move(logFile), logFileMode);

    if (!Client::findCompiler(preresolved)) {
        ERROR("Can't find executable for %s", data.argv[0]);
        return 1;
    }
    DEBUG("Resolved compiler %s (%s) to \"%s\" \"%s\" \"%s\")",
          data.argv[0], preresolved ? preresolved : "",
          data.compiler.c_str(), data.resolvedCompiler.c_str(),
          data.slaveCompiler.c_str());

    if (disabled) {
        DEBUG("Have to run locally because we're disabled");
        Client::runLocal(Client::acquireSlot(Client::Slot::Compile));
        return 0; // unreachable
    }

    std::vector<std::string> args(data.argc);
    for (int i=0; i<data.argc; ++i) {
        // printf("%zu: %s\n", i, argv[i]);
        args[i] = data.argv[i];
    }
    data.compilerArgs = CompilerArgs::create(args);
    if (!data.compilerArgs
        || data.compilerArgs->mode != CompilerArgs::Compile
        || data.compilerArgs->flags & CompilerArgs::StdinInput
        || data.compilerArgs->sourceFileIndexes.size() != 1) {
        DEBUG("Have to run locally because mode %s - flags 0x%x - source files: %zu",
              CompilerArgs::modeName(data.compilerArgs ? data.compilerArgs->mode : CompilerArgs::Invalid),
              data.compilerArgs ? data.compilerArgs->flags : 0, data.compilerArgs ? data.compilerArgs->sourceFileIndexes.size() : 0);
        Client::runLocal(Client::acquireSlot(Client::Slot::Compile));
        return 0; // unreachable
    }

    SchedulerWebSocket schedulerWebsocket;

    struct sigaction act;
    memset(&act, 0, sizeof(struct sigaction));
    act.sa_handler = SIG_IGN;
    sigaction(SIGPIPE, &act, 0);

    std::unique_ptr<Client::Preprocessed> preprocessed = Client::preprocess(data.compiler, data.compilerArgs);
    if (!preprocessed) {
        ERROR("Failed to preprocess");
        watchdog.stop();
        Client::runLocal(Client::acquireSlot(Client::Slot::Compile));
        return 0; // unreachable
    }

    data.hash = Client::environmentHash(data.resolvedCompiler);
    std::vector<std::string> compatibleHashes = Config::compatibleHashes(data.hash);
    std::string hashes = data.hash;
    for (const std::string &compatibleHash : compatibleHashes) {
        hashes += ";" + compatibleHash;
    }
    DEBUG("Got hashes %s for %s", hashes.c_str(), data.resolvedCompiler.c_str());
    std::map<std::string, std::string> headers;
    headers["x-fisk-environments"] = hashes;
    Client::parsePath(data.compilerArgs->sourceFile(0), &headers["x-fisk-sourcefile"], 0);
    headers["x-fisk-client-name"] = Config::name();
    if (slave)
        headers["x-fisk-slave"] = slave;
    {
        std::string hostname = Config::hostname();
        if (!hostname.empty())
            headers["x-fisk-client-hostname"] = std::move(hostname);
    }
    if (!schedulerWebsocket.connect(Config::scheduler() + "/compile", headers)) {
        DEBUG("Have to run locally because no server");
        watchdog.stop();
        Client::runLocal(Client::acquireSlot(Client::Slot::Compile));
        return 0; // unreachable
    }

    {
        Select select;
        select.add(&watchdog);
        select.add(&schedulerWebsocket);

        DEBUG("Starting schedulerWebsocket");
        while (!schedulerWebsocket.done && schedulerWebsocket.state() <= SchedulerWebSocket::ConnectedWebSocket)
            select.exec();
        DEBUG("Finished schedulerWebsocket");
    }

    if ((data.slaveHostname.empty() && data.slaveIp.empty()) || !data.slavePort) {
        DEBUG("Have to run locally because no slave");
        watchdog.stop();
        Client::runLocal(Client::acquireSlot(Client::Slot::Compile));
        return 0; // unreachable
    }

    // usleep(1000 * 1000 * 16);
    watchdog.transition(Watchdog::AcquiredSlave);
    SlaveWebSocket slaveWebSocket;
    Select select;
    select.add(&slaveWebSocket);
    select.add(&watchdog);
    headers["x-fisk-job-id"] = std::to_string(data.jobId);
    if (!slaveWebSocket.connect(Client::format("ws://%s:%d/compile",
                                               data.slaveHostname.empty() ? data.slaveIp.c_str() : data.slaveHostname.c_str(),
                                               data.slavePort), headers)) {
        DEBUG("Have to run locally because no slave connection");
        watchdog.stop();
        Client::runLocal(Client::acquireSlot(Client::Slot::Compile));
        return 0; // unreachable
    }

    while (slaveWebSocket.state() < SchedulerWebSocket::ConnectedWebSocket)
        select.exec();

    DEBUG("Waiting for preprocessed");
    preprocessed->wait();
    DEBUG("Preprocessed finished");
    preprocessedDuration = preprocessed->duration;
    preprocessedSlotDuration = preprocessed->slotDuration;

    if (preprocessed->exitStatus != 0) {
        ERROR("Failed to preprocess. Running locally");
        watchdog.stop();
        Client::runLocal(Client::acquireSlot(Client::Slot::Compile));
        return 0; // unreachable
    }

    args[0] = data.slaveCompiler;
    const bool wait = slaveWebSocket.handshakeResponseHeader("x-fisk-wait") == "true";
    json11::Json::object msg {
        { "commandLine", args },
        { "argv0", data.compiler },
        { "wait", wait },
        { "bytes", static_cast<int>(preprocessed->stdOut.size()) }
    };

    std::string json = json11::Json(msg).dump();
    slaveWebSocket.wait = wait;
    slaveWebSocket.send(WebSocket::Text, json.c_str(), json.size());
    if (wait) {
        while ((slaveWebSocket.hasPendingSendData() || slaveWebSocket.wait) && slaveWebSocket.state() == SchedulerWebSocket::ConnectedWebSocket)
            select.exec();
        if (slaveWebSocket.state() != SchedulerWebSocket::ConnectedWebSocket) {
            DEBUG("Have to run locally because something went wrong with the slave");
            watchdog.stop();
            Client::runLocal(Client::acquireSlot(Client::Slot::Compile));
            return 0; // unreachable
        }
    }

    assert(!slaveWebSocket.wait);
    slaveWebSocket.send(WebSocket::Binary, preprocessed->stdOut.c_str(), preprocessed->stdOut.size());

    while (slaveWebSocket.hasPendingSendData() && slaveWebSocket.state() == SchedulerWebSocket::ConnectedWebSocket)
        select.exec();
    if (slaveWebSocket.state() != SchedulerWebSocket::ConnectedWebSocket) {
        DEBUG("Have to run locally because something went wrong with the slave");
        watchdog.stop();
        Client::runLocal(Client::acquireSlot(Client::Slot::Compile));
        return 0; // unreachable
    }

    watchdog.transition(Watchdog::UploadedJob);

    // usleep(1000 * 500);
    // return 0;
    while (!slaveWebSocket.done && slaveWebSocket.state() == SchedulerWebSocket::ConnectedWebSocket)
        select.exec();
    if (slaveWebSocket.done) {
        if (!preprocessed->stdErr.empty()) {
            fwrite(preprocessed->stdErr.c_str(), sizeof(char), preprocessed->stdErr.size(), stderr);
        }
        watchdog.transition(Watchdog::Finished);
        watchdog.stop();
        schedulerWebsocket.close("slaved");
        return data.exitCode;
    }

    DEBUG("Have to run locally because something went wrong with the slave, part deux");
    watchdog.stop();
    Client::runLocal(Client::acquireSlot(Client::Slot::Compile));
    return 0; // unreachable
}
