// WebSocket speed-test server (C++17, Boost.Beast). See ../README.md for the protocol.
#include <boost/asio.hpp>
#include <boost/beast.hpp>
#include <boost/json.hpp>
#include <boost/json/src.hpp> // header-only Boost.JSON: compile it into this translation unit

#include <sys/resource.h>
#include <unistd.h>

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <deque>
#include <fstream>
#include <iostream>
#include <memory>
#include <sstream>
#include <string>
#include <thread>
#include <vector>

namespace beast = boost::beast;
namespace websocket = beast::websocket;
namespace net = boost::asio;
namespace json = boost::json;
using tcp = net::ip::tcp;

static std::atomic<uint64_t> g_conns{0}, g_in{0}, g_out{0};
static const auto g_started = std::chrono::steady_clock::now();
static constexpr double MB = 1048576.0;

// ---- process stats (reply to @{"cmd":"stats"}) ----
static std::string run_cmd(const std::string& cmd) {
  std::string out;
  if (FILE* p = popen(cmd.c_str(), "r")) {
    char buf[256];
    while (size_t n = fread(buf, 1, sizeof buf, p)) out.append(buf, n);
    pclose(p);
  }
  return out;
}

static double cpu_ms() {
  rusage ru{};
  getrusage(RUSAGE_SELF, &ru);
  auto tv = [](const timeval& t) { return t.tv_sec * 1000.0 + t.tv_usec / 1000.0; };
  return tv(ru.ru_utime) + tv(ru.ru_stime);
}

static json::value os_threads() {
  const std::string pid = std::to_string(getpid());
#ifdef __linux__
  std::ifstream f("/proc/self/status");
  for (std::string line; std::getline(f, line);)
    if (line.rfind("Threads:", 0) == 0) return std::atoll(line.c_str() + 8);
  return nullptr;
#else
  std::string out = run_cmd("ps -M -p " + pid);
  long lines = std::count(out.begin(), out.end(), '\n');
  return lines > 0 ? json::value(lines - 1) : json::value(nullptr);
#endif
}

static std::string stats_message(unsigned workers) {
  const std::string pid = std::to_string(getpid());
  std::string rss = run_cmd("ps -o rss= -p " + pid);
  json::object v;
  v["evt"] = "stats";
  v["server"] = "cpp";
  v["pid"] = static_cast<int64_t>(getpid());
  v["uptimeS"] = std::chrono::duration<double>(std::chrono::steady_clock::now() - g_started).count();
  v["cpuCores"] = static_cast<int64_t>(std::thread::hardware_concurrency());
  v["rssMB"] = rss.empty() ? json::value(nullptr) : json::value(std::atof(rss.c_str()) / 1024.0);
  v["heapMB"] = nullptr;
  v["threads"] = os_threads();
  v["processes"] = nullptr;
  v["connections"] = g_conns.load();
  v["msgsIn"] = g_in.load();
  v["msgsOut"] = g_out.load();
  v["cpuMs"] = cpu_ms();
  v["extra"] = json::object{{"ioThreads", static_cast<int64_t>(workers)}};
  return "@" + json::serialize(v);
}

static unsigned g_workers = 1;

class Session : public std::enable_shared_from_this<Session> {
  enum class Mode { Echo, Generate };

  websocket::stream<beast::tcp_stream> ws_;
  beast::flat_buffer buf_;
  Mode mode_ = Mode::Echo;

  std::deque<std::pair<std::string, bool>> q_; // pending (payload, is_text)
  std::string cur_;                            // frame currently being written
  bool cur_text_ = true;
  bool writing_ = false;

  bool gen_ = false;
  uint64_t gi_ = 0, gcount_ = 0;
  size_t gsize_ = 0;
  std::string pad_;
  std::chrono::steady_clock::time_point gstart_;

 public:
  explicit Session(tcp::socket&& s) : ws_(std::move(s)) {}
  ~Session() { g_conns--; }

  void run() {
    beast::get_lowest_layer(ws_).socket().set_option(tcp::no_delay(true));
    ws_.auto_fragment(false);
    g_conns++;
    ws_.async_accept(beast::bind_front_handler(&Session::on_accept, shared_from_this()));
  }

 private:
  void on_accept(beast::error_code ec) {
    if (!ec) do_read();
  }

  void do_read() {
    ws_.async_read(buf_, beast::bind_front_handler(&Session::on_read, shared_from_this()));
  }

  void on_read(beast::error_code ec, size_t) {
    if (ec) return; // closed or failed: session is released when no handlers remain
    const auto data = buf_.data();
    const char* p = static_cast<const char*>(data.data());
    const size_t len = data.size();
    const bool text = ws_.got_text();
    if (text && len > 0 && p[0] == '@') {
      control(std::string(p + 1, len - 1));
    } else {
      g_in++;
      if (mode_ == Mode::Echo) {
        g_out++;
        enqueue(std::string(p, len), text);
      }
    }
    buf_.consume(len);
    do_read();
  }

  void control(const std::string& body) {
    beast::error_code ec;
    json::value jv = json::parse(body, ec);
    if (ec || !jv.is_object()) return;
    const auto& o = jv.as_object();
    const auto* c = o.if_contains("cmd");
    if (!c || !c->is_string()) return;
    const std::string cmd(c->as_string());

    if (cmd == "info" || cmd == "mode") {
      if (cmd == "mode") {
        if (const auto* m = o.if_contains("mode"); m && m->is_string()) {
          if (m->as_string() == "echo") mode_ = Mode::Echo;
          else if (m->as_string() == "generate") mode_ = Mode::Generate;
        }
      }
      json::object info{{"evt", "info"}, {"server", "cpp"}, {"runtime", "C++17 Boost.Beast"},
                        {"mode", mode_ == Mode::Echo ? "echo" : "generate"}};
      enqueue("@" + json::serialize(info), true);
    } else if (cmd == "stats") {
      enqueue(stats_message(g_workers), true);
    } else if (cmd == "start" && mode_ == Mode::Generate && !gen_) {
      auto num = [&](const char* k) -> int64_t {
        const auto* v = o.if_contains(k);
        return v && v->is_number() ? std::max<int64_t>(0, v->to_number<int64_t>()) : 0;
      };
      gcount_ = num("count");
      gsize_ = num("size");
      pad_.assign(gsize_, 'x');
      gi_ = 0;
      gen_ = true;
      gstart_ = std::chrono::steady_clock::now();
      kick();
    }
  }

  void enqueue(std::string data, bool text) {
    q_.emplace_back(std::move(data), text);
    kick();
  }

  void kick() {
    if (!writing_) do_write();
  }

  // One async_write in flight at a time; the generator only produces the next frame once the previous
  // one is written, which gives natural backpressure.
  void do_write() {
    if (!q_.empty()) {
      cur_ = std::move(q_.front().first);
      cur_text_ = q_.front().second;
      q_.pop_front();
    } else if (gen_) {
      generate_burst();
      return;
    } else {
      writing_ = false;
      return;
    }
    writing_ = true;
    ws_.text(cur_text_);
    ws_.async_write(net::buffer(cur_), beast::bind_front_handler(&Session::on_write, shared_from_this()));
  }

  // Generate-mode fast path: write a burst of frames synchronously (one syscall each, no handler hop), then
  // yield to the event loop so reads and other sessions on this thread still get served.
  void generate_burst() {
    writing_ = true;
    beast::error_code ec;
    ws_.text(true);
    for (int n = 0; n < 64 && gi_ < gcount_; n++) {
      cur_.clear();
      cur_ += std::to_string(gi_++);
      cur_ += '|';
      cur_ += pad_;
      ws_.write(net::buffer(cur_), ec);
      if (ec) return;
      g_out++;
    }
    if (gi_ >= gcount_) {
      const double ms =
          std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - gstart_).count();
      json::object done{{"evt", "done"}, {"count", gcount_}, {"size", gsize_}, {"serverMs", ms}};
      ws_.write(net::buffer("@" + json::serialize(done)), ec);
      gen_ = false;
    }
    net::post(ws_.get_executor(), [self = shared_from_this()] {
      self->writing_ = false;
      self->kick();
    });
  }

  void on_write(beast::error_code ec, size_t) {
    if (ec) return;
    do_write();
  }
};

// One single-threaded io_context per core; each connection lives on one of them (no locking, no cross-thread hops).
class Listener : public std::enable_shared_from_this<Listener> {
  std::vector<std::unique_ptr<net::io_context>>& iocs_;
  tcp::acceptor acceptor_;
  size_t next_ = 0;

 public:
  Listener(std::vector<std::unique_ptr<net::io_context>>& iocs, tcp::endpoint ep)
      : iocs_(iocs), acceptor_(*iocs[0]) {
    acceptor_.open(ep.protocol());
    acceptor_.set_option(net::socket_base::reuse_address(true));
    acceptor_.bind(ep);
    acceptor_.listen(net::socket_base::max_listen_connections);
  }
  void run() { do_accept(); }

 private:
  void do_accept() {
    auto& target = *iocs_[next_++ % iocs_.size()];
    acceptor_.async_accept(target, [self = shared_from_this()](beast::error_code ec, tcp::socket s) {
      if (!ec) std::make_shared<Session>(std::move(s))->run();
      self->do_accept();
    });
  }
};

int main() {
  const char* env = std::getenv("PORT");
  const auto port = static_cast<unsigned short>(env ? std::atoi(env) : 8086);
  g_workers = std::max(1u, std::thread::hardware_concurrency());

  std::vector<std::unique_ptr<net::io_context>> iocs;
  std::vector<net::executor_work_guard<net::io_context::executor_type>> guards;
  for (unsigned i = 0; i < g_workers; i++) {
    iocs.push_back(std::make_unique<net::io_context>(1)); // concurrency hint 1: lock-free fast path
    guards.emplace_back(iocs.back()->get_executor());
  }

  std::make_shared<Listener>(iocs, tcp::endpoint{tcp::v4(), port})->run();
  std::cout << "cpp server listening on ws://localhost:" << port << "/ws" << std::endl;

  std::vector<std::thread> pool;
  for (unsigned i = 1; i < g_workers; i++) pool.emplace_back([&, i] { iocs[i]->run(); });
  iocs[0]->run();
  for (auto& t : pool) t.join();
}
