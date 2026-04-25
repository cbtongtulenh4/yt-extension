let currentWindowId = null;

document.addEventListener('DOMContentLoaded', () => {
    chrome.windows.getCurrent((win) => {
        currentWindowId = win.id;
        const configKey = `ytConfig_${currentWindowId}`;

        // 1. Khôi phục cấu hình (Ưu tiên cấu hình riêng của cửa sổ, nếu không có thì dùng cấu hình chung)
        chrome.storage.local.get([configKey, 'ytConfig'], (data) => {
            const config = data[configKey] || data.ytConfig;
            if (config) {
                document.getElementById('config-check-quality').checked = config.checkQuality !== undefined ? config.checkQuality : true;
                document.getElementById('config-quality').value = config.quality || '1080';
                document.getElementById('config-check-len').checked = config.checkLen !== undefined ? config.checkLen : true;
                document.getElementById('config-min-len').value = config.minLen !== undefined ? config.minLen : 0;
                document.getElementById('config-max-len').value = config.maxLen !== undefined ? config.maxLen : 60;
                document.getElementById('config-check-views').checked = config.checkViews !== undefined ? config.checkViews : true;
                document.getElementById('config-min-view').value = config.minViewFormat || '100K';
                document.getElementById('config-check-time').checked = config.checkTime !== undefined ? config.checkTime : true;
                document.getElementById('config-max-days').value = config.maxDays !== undefined ? config.maxDays : 30;
                document.getElementById('config-check-auto').checked = config.checkAuto !== undefined ? config.checkAuto : false;
                document.getElementById('config-max-count').value = config.maxCount !== undefined ? config.maxCount : 0;
                document.getElementById('config-only-valid').checked = config.onlyValid !== undefined ? config.onlyValid : false;
                document.getElementById('config-direct-mode').checked = config.directMode !== undefined ? config.directMode : false;
                updateStatusLabel(config.checkAuto !== undefined ? config.checkAuto : false, config.maxCount !== undefined ? config.maxCount : 0);
            } else {
                // Save defaults
                saveAndSyncConfig();
            }
        });
    });

    // 2. Tự động sync (cập nhật) mỗi khi User thay đổi bất kì thông số nào trên box
    const inputs = document.querySelectorAll('input, select');
    inputs.forEach(input => {
        if (input.type === 'checkbox' || input.tagName === 'SELECT') {
            input.addEventListener('change', saveAndSyncConfig);
        } else {
            input.addEventListener('input', () => {
                clearTimeout(input.timer);
                input.timer = setTimeout(saveAndSyncConfig, 300); // Nhanh hơn: 300ms
            });
        }
    });

    // 2.5 Lắng nghe sự kiện click vào nút Auto-Scan to
    document.getElementById('status-toggle-btn').addEventListener('click', () => {
        const autoCheck = document.getElementById('config-check-auto');
        autoCheck.checked = !autoCheck.checked;
        saveAndSyncConfig();
    });

    // 3. Nút Download Hàng Loạt (Gửi lệnh gộp)
    document.getElementById('bulk-download-btn').addEventListener('click', () => {
        let btn = document.getElementById('bulk-download-btn');
        let oldText = btn.textContent;
        btn.textContent = "🚀 ĐANG GỬI LỆNH TẢI...";

        chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
            if (tabs.length > 0 && tabs[0].url && tabs[0].url.includes("youtube.com")) {
                chrome.tabs.sendMessage(tabs[0].id, { action: "BULK_DOWNLOAD" }, (response) => {
                    if (response && response.count !== undefined) {
                        btn.textContent = `✅ ĐÃ GỬI ${response.count} VIDEO!`;
                        btn.style.background = "#059669";
                        setTimeout(() => {
                            btn.textContent = oldText;
                            btn.style.background = "";
                        }, 3000);
                    } else {
                        btn.textContent = `⚠️ LỖI: TRANG CHƯA SẴN SÀNG!`;
                        btn.style.background = "#e11d48";
                        setTimeout(() => {
                            btn.textContent = oldText;
                            btn.style.background = "";
                        }, 3000);
                    }
                });
            } else {
                btn.textContent = `❌ HÃY MỞ TRANG YOUTUBE!`;
                btn.style.background = "#e11d48";
                setTimeout(() => {
                    btn.textContent = oldText;
                    btn.style.background = "";
                }, 3000);
            }
        });
    });
});

function saveAndSyncConfig() {
    const isAutoChecked = document.getElementById('config-check-auto').checked;
    const maxVal = parseInt(document.getElementById('config-max-count').value);
    const safeMaxVal = isNaN(maxVal) ? 0 : maxVal;

    const newConfig = {
        checkQuality: document.getElementById('config-check-quality').checked,
        quality: document.getElementById('config-quality').value,
        checkLen: document.getElementById('config-check-len').checked,
        minLen: parseInt(document.getElementById('config-min-len').value) || 0,
        maxLen: parseInt(document.getElementById('config-max-len').value) || 9999,
        checkViews: document.getElementById('config-check-views').checked,
        minViewFormat: document.getElementById('config-min-view').value,
        checkTime: document.getElementById('config-check-time').checked,
        maxDays: parseInt(document.getElementById('config-max-days').value) || 30,
        checkAuto: isAutoChecked,
        maxCount: safeMaxVal,
        onlyValid: document.getElementById('config-only-valid').checked,
        directMode: document.getElementById('config-direct-mode').checked
    };

    // Cập nhật nhãn trạng thái cục bộ dựa trên checkbox Auto
    updateStatusLabel(isAutoChecked, safeMaxVal);

    const storageData = { ytConfig: newConfig }; // Lưu làm mặc định chung
    if (currentWindowId) {
        storageData[`ytConfig_${currentWindowId}`] = newConfig; // Lưu riêng cho cửa sổ này
    }

    chrome.storage.local.set(storageData, () => {
        // Sync xuống TẤT CẢ các Tab trong cửa sổ hiện tại
        chrome.tabs.query({ windowId: currentWindowId }, function (tabs) {
            tabs.forEach(tab => {
                if (tab.url && tab.url.includes("youtube.com")) {
                    chrome.tabs.sendMessage(tab.id, {
                        action: "UPDATE_CONFIG",
                        config: newConfig
                    }).catch(() => { });
                }
            });
        });
    });
}


function updateStatusLabel(isAutoChecked, maxCount) {
    const status = document.getElementById('scan-status');
    if (isAutoChecked) {
        if (maxCount > 0) {
            status.textContent = `📡 Đang Quét (${maxCount})`;
            status.className = "status-active";
        } else {
            status.textContent = "Mặc Định";
            status.className = "status-idle";
        }
    } else {
        status.textContent = "💤 Đã Tắt Scan";
        status.className = "status-idle";
    }
}
