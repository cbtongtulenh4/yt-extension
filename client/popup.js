document.addEventListener('DOMContentLoaded', () => {
    // 1. Khôi phục cấu hình
    chrome.storage.local.get(['ytConfig'], (data) => {
        if (data.ytConfig) {
            document.getElementById('config-quality').value = data.ytConfig.quality || '1080';
            document.getElementById('config-min-len').value = data.ytConfig.minLen !== undefined ? data.ytConfig.minLen : 0;
            document.getElementById('config-max-len').value = data.ytConfig.maxLen !== undefined ? data.ytConfig.maxLen : 60;
            document.getElementById('config-check-views').checked = data.ytConfig.checkViews !== undefined ? data.ytConfig.checkViews : true;
            document.getElementById('config-min-view').value = data.ytConfig.minViewFormat || '100K';
            document.getElementById('config-check-time').checked = data.ytConfig.checkTime !== undefined ? data.ytConfig.checkTime : true;
            document.getElementById('config-max-days').value = data.ytConfig.maxDays !== undefined ? data.ytConfig.maxDays : 30;
            document.getElementById('config-max-count').value = data.ytConfig.maxCount !== undefined ? data.ytConfig.maxCount : 0;
            updateStatusLabel(data.ytConfig.maxCount || 0);
        } else {
            // Save defaults
            saveAndSyncConfig();
        }
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

    // 3. Nút Download Hàng Loạt (Gửi lệnh gộp)
    document.getElementById('bulk-download-btn').addEventListener('click', () => {
        let btn = document.getElementById('bulk-download-btn');
        let oldText = btn.textContent;
        btn.textContent = "🚀 ĐANG GỬI LỆNH TẢI...";
        
        chrome.tabs.query({active: true, currentWindow: true}, function(tabs) {
            if (tabs.length > 0 && tabs[0].url.includes("youtube.com")) {
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
    // Thu thập giá trị hiện tại
    const maxVal = parseInt(document.getElementById('config-max-count').value);
    const safeMaxVal = isNaN(maxVal) ? 0 : maxVal;

    const newConfig = {
        quality: document.getElementById('config-quality').value,
        minLen: parseInt(document.getElementById('config-min-len').value) || 0,
        maxLen: parseInt(document.getElementById('config-max-len').value) || 9999,
        checkViews: document.getElementById('config-check-views').checked,
        minViewFormat: document.getElementById('config-min-view').value,
        checkTime: document.getElementById('config-check-time').checked,
        maxDays: parseInt(document.getElementById('config-max-days').value) || 30,
        maxCount: safeMaxVal
    };
    
    // Cập nhật nhãn trạng thái cục bộ ngay lập tức
    updateStatusLabel(safeMaxVal);

    chrome.storage.local.set({ ytConfig: newConfig }, () => {
        // Sync xuống Tab đang mở
        chrome.tabs.query({active: true, currentWindow: true}, function(tabs) {
            if (tabs.length > 0 && tabs[0].url.includes("youtube.com")) {
                chrome.tabs.sendMessage(tabs[0].id, {
                    action: "UPDATE_CONFIG",
                    config: newConfig
                }).catch(() => {});
            }
        });
    });
}

function updateStatusLabel(maxCount) {
    const status = document.getElementById('scan-status');
    if (maxCount > 0) {
        status.textContent = "📡 Đang Hoạt Động";
        status.className = "status-active";
    } else {
        status.textContent = "💤 Đã Tắt";
        status.className = "status-idle";
    }
}
