#pragma once

#include "window/WindowChromeState.h"

class WebViewHost;

struct WindowChromeApplyHooks {
    HWND hwnd = nullptr;
    WebViewHost* webView = nullptr;
    const char* diagnosticWindowKind = nullptr;
    const char* diagnosticWindowId = nullptr;
    bool diagnosticStartupRevealPending = false;
    bool diagnosticStartupRevealCommitted = false;
    bool diagnosticStartupRevealSettling = false;
    bool diagnosticIsActive = false;
    std::function<void(bool)> applyFrameless;
    std::function<void(WindowNativeFrameStrategy)> applyNativeFrameStrategy;
    std::function<void(const std::string&)> applyCornerPreference;
    // Clear window (main window only): blur-behind requested with no system backdrop over a transparent
    // WebView. The window then drops everything DWM draws for it (frame sheet, border, shadow, rounded
    // corners) so only the page shows on the desktop. Args: (clear, fullscreen)
    std::function<void(bool, bool)> applyClearWindow;
    std::function<void()> afterBackdropApplied;
    std::function<bool()> canBroadcastBackdropStateChanged;
    std::function<void(bool, const std::string&, const std::string&)> broadcastBackdropStateChanged;
};

struct WindowChromeApplyRequest {
    ResolvedWindowChromeState state;
    bool active = true;
    bool forceRefresh = false;
    std::string previousMode;
    std::string previousEffect;
};

struct WindowChromeApplyResult {
    std::string mode;
    std::string effect;
    bool success = true;
};

class WindowChromeApplier {
public:
    static WindowChromeApplyResult Apply(const WindowChromeApplyHooks& hooks,
                                         const WindowChromeApplyRequest& request);
    static void RefreshNativeFrame(HWND hwnd);
};