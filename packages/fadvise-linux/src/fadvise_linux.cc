#include <napi.h>

#include <cerrno>
#include <cstring>

#if defined(__linux__)
#include <fcntl.h>
#endif

namespace {

Napi::Value FadviseDontNeed(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();

  if (info.Length() < 1 || !info[0].IsNumber()) {
    Napi::TypeError::New(env, "fd must be provided as a number").ThrowAsJavaScriptException();
    return env.Null();
  }

  const int fd = info[0].As<Napi::Number>().Int32Value();
  const std::uint64_t offset = info.Length() > 1 && info[1].IsNumber()
    ? info[1].As<Napi::Number>().Int64Value()
    : 0;
  const std::uint64_t len = info.Length() > 2 && info[2].IsNumber()
    ? info[2].As<Napi::Number>().Int64Value()
    : 0;

#if defined(__linux__)
  const int rc = posix_fadvise(fd, static_cast<off_t>(offset), static_cast<off_t>(len), POSIX_FADV_DONTNEED);
  if (rc != 0) {
    Napi::Error error = Napi::Error::New(env, std::strerror(rc));
    error.Set("code", Napi::String::New(env, "FADVISE_FAILED"));
    error.Set("errno", Napi::Number::New(env, rc));
    error.ThrowAsJavaScriptException();
    return env.Null();
  }

  return Napi::Boolean::New(env, true);
#else
  Napi::Error error = Napi::Error::New(env, "posix_fadvise(DONTNEED) is only supported on Linux");
  error.Set("code", Napi::String::New(env, "FADVISE_UNSUPPORTED_PLATFORM"));
  error.ThrowAsJavaScriptException();
  return env.Null();
#endif
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set("fadviseDontNeed", Napi::Function::New(env, FadviseDontNeed));
  return exports;
}

}  // namespace

NODE_API_MODULE(fadvise_linux, Init)
