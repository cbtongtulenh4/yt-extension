chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === "GET_WINDOW_ID") {
        // Trả về windowId của tab gửi yêu cầu
        if (sender.tab) {
            sendResponse({ windowId: sender.tab.windowId });
        } else {
            sendResponse({ windowId: null });
        }
    }
    return true;
});
