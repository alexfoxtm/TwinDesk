// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Loaded by Electron's main process: notification authorization belongs to that app,
// not to the separately signed helper executable.
#include <node_api.h>
#import <Foundation/Foundation.h>
#import <UserNotifications/UserNotifications.h>
#import <CoreGraphics/CoreGraphics.h>
#include <memory>
#include <atomic>
#include <string>

struct Query {
  napi_deferred deferred;
  napi_async_work work;
  bool request;
  std::atomic<bool> done{false};
  std::atomic<bool> failed{false};
  std::atomic<NSInteger> authorization{-1};
  std::atomic<NSInteger> alert{-1};
  std::string bundle;
  dispatch_semaphore_t signal = dispatch_semaphore_create(0);
};
using HeldQuery = std::shared_ptr<Query>;

static const char* Authorization(NSInteger value) {
  switch (value) {
    case UNAuthorizationStatusNotDetermined: return "not-determined";
    case UNAuthorizationStatusDenied: return "denied";
    case UNAuthorizationStatusAuthorized: return "authorized";
    case UNAuthorizationStatusProvisional: return "provisional";
    default: return "unknown";
  }
}

static void Execute(napi_env, void* data) {
  const auto q = *static_cast<HeldQuery*>(data);
  @autoreleasepool {
    q->bundle = NSBundle.mainBundle.bundleIdentifier.UTF8String ?: "";
    UNUserNotificationCenter* center = UNUserNotificationCenter.currentNotificationCenter;
    void (^read)(void) = ^{
      [center getNotificationSettingsWithCompletionHandler:^(UNNotificationSettings* settings) {
        q->authorization = settings.authorizationStatus;
        q->alert = settings.alertSetting;
        q->done = true;
        dispatch_semaphore_signal(q->signal);
      }];
    };
    if (q->request) {
      [center requestAuthorizationWithOptions:(UNAuthorizationOptionAlert | UNAuthorizationOptionSound | UNAuthorizationOptionBadge)
                           completionHandler:^(BOOL granted, NSError* error) {
        if (error) {
          q->failed = true;
          dispatch_semaphore_signal(q->signal);
        } else read();
      }];
    } else read();
    // The blocks retain q if the OS replies after this timeout; no callback can use freed data.
    dispatch_semaphore_wait(q->signal, dispatch_time(DISPATCH_TIME_NOW, 30 * NSEC_PER_SEC));
  }
}

static void Complete(napi_env env, napi_status status, void* data) {
  std::unique_ptr<HeldQuery> held(static_cast<HeldQuery*>(data));
  const auto q = *held;
  if (status != napi_ok || !q->done || q->failed) {
    napi_value message, error;
    napi_create_string_utf8(env, "Could not check macOS notification authorization", NAPI_AUTO_LENGTH, &message);
    napi_create_error(env, nullptr, message, &error);
    napi_reject_deferred(env, q->deferred, error);
  } else {
    napi_value result, value;
    napi_create_object(env, &result);
    napi_create_string_utf8(env, Authorization(q->authorization), NAPI_AUTO_LENGTH, &value);
    napi_set_named_property(env, result, "authorization", value);
    const char* alert = q->alert == UNNotificationSettingEnabled ? "enabled" : q->alert == UNNotificationSettingDisabled ? "disabled" : "unknown";
    napi_create_string_utf8(env, alert, NAPI_AUTO_LENGTH, &value);
    napi_set_named_property(env, result, "alerts", value);
    napi_create_string_utf8(env, q->bundle.c_str(), NAPI_AUTO_LENGTH, &value);
    napi_set_named_property(env, result, "bundleId", value);
    napi_resolve_deferred(env, q->deferred, result);
  }
  napi_delete_async_work(env, q->work);
}

static napi_value Start(napi_env env, bool request) {
  auto q = std::make_shared<Query>();
  q->request = request;
  napi_value promise, name;
  napi_create_promise(env, &q->deferred, &promise);
  napi_create_string_utf8(env, "notification authorization", NAPI_AUTO_LENGTH, &name);
  auto* held = new HeldQuery(q);
  if (napi_create_async_work(env, nullptr, name, Execute, Complete, held, &q->work) != napi_ok) {
    delete held;
    napi_throw_error(env, nullptr, "Could not check macOS notification authorization");
    return nullptr;
  }
  if (napi_queue_async_work(env, q->work) != napi_ok) {
    napi_delete_async_work(env, q->work);
    delete held;
    napi_throw_error(env, nullptr, "Could not check macOS notification authorization");
    return nullptr;
  }
  return promise;
}

static napi_value Get(napi_env env, napi_callback_info) { return Start(env, false); }
static napi_value Request(napi_env env, napi_callback_info) { return Start(env, true); }
// Node-API invokes this on Electron's main thread. Request for the application that captures,
// rather than for the separate helper process; an existing grant needs no new request.
static napi_value RequestScreen(napi_env env, napi_callback_info) {
  const bool granted = CGPreflightScreenCaptureAccess() || CGRequestScreenCaptureAccess();
  napi_value result;
  napi_get_boolean(env, granted, &result);
  return result;
}
static napi_value Init(napi_env env, napi_value exports) {
  const napi_property_descriptor methods[] = {
    {"getSettings", nullptr, Get, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"request", nullptr, Request, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"requestScreenAccess", nullptr, RequestScreen, nullptr, nullptr, nullptr, napi_default, nullptr},
  };
  napi_define_properties(env, exports, 3, methods);
  return exports;
}
NAPI_MODULE(notification_permission, Init)
