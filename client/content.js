let currentConfig = {
    quality: '1080', minLen: 0, maxLen: 60, checkViews: true, minView: 100000, checkTime: true, maxDays: 30, maxCount: 0
};
let validFoundCount = 0; 
let scanInterval = null;
let bulkDownloadItems = new Map(); // Link Element Youtube => Nút bấm Button để auto nhấn

// ==========================================
// TOAST THÔNG BÁO UI
// ==========================================
const toastHTML = `<div id="yt-ext-toast"></div>`;
document.body.insertAdjacentHTML('beforeend', toastHTML);

function showToast(msg, duration = 3000) {
    let t = document.getElementById('yt-ext-toast');
    if (!t) return;
    t.innerText = msg;
    t.classList.add('show');
    if (t.timer) clearTimeout(t.timer);
    if (duration > 0) {
        t.timer = setTimeout(() => t.classList.remove('show'), duration);
    }
}

// ==========================================
// KHỞI ĐỘNG CƠ CHẾ QUÉT NỀN LIÊN TỤC
// ==========================================
chrome.storage.local.get(['ytConfig'], (data) => {
    if (data.ytConfig) {
        currentConfig = parseConfig(data.ytConfig);
    }
    // Ghim lặp liên tục mỗi 2s để đắp giao diện
    scanInterval = setInterval(processVideos, 2000);
});

// Lắng nghe lệnh từ Popup truyền đi (như Đổi Option hay Bấm Bulk Tải)
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === "UPDATE_CONFIG") {
        currentConfig = parseConfig(request.config);
        fullReset(); // Thực hiện reset hoàn toàn khi đổi cấu hình
        showToast("🔄 Đã tự động cập nhật lại Lọc Video!", 2500);
        sendResponse({ status: "ok" });
        
    } else if (request.action === "BULK_DOWNLOAD") {
        let count = 0;
        bulkDownloadItems.forEach((btnElement, url) => {
            // Kiểm tra nếu nút vẫn đang ở trạng thái sẵn sàng (chưa bị disabled do đang tải)
            if (!btnElement.disabled) {
                sendDownloadRequest(url, currentConfig.quality || '1080', btnElement);
                count++;
            }
        });
        showToast(`💥 Phát động Bulk Download thành công ${count} video!`, 4000);
        sendResponse({ status: "ok", count: count });
    }
    return true;
});

// Hàm reset trạng thái toàn cục (Dùng khi đổi trang hoặc đổi cấu hình)
function fullReset() {
    resetProcessedItems();
    validFoundCount = 0;
    bulkDownloadItems.clear();
    
    // Xóa bộ nhớ chọn thủ công khi chuyển trang hoặc đổi cấu hình
    manuallySelectedItems.clear();
    if (isManualSelectionMode) {
        showToast(`Giỏ hàng: 0 video thủ công.\n(Nhấn ENTER để Tải)`, 0);
    }
    
    processVideos(); // Lập tức ép duyệt lại
}

// Bắt sự kiện chuyển hướng trang của YouTube (Single Page App)
window.addEventListener('yt-navigate-finish', () => {
    console.log("[YT-EXT] Phát hiện chuyển trang (Event), đang làm mới bộ lọc...");
    fullReset();
});

// Cơ chế Polling URL phòng hờ sự kiện navigate-finish không kích hoạt ổn định
let lastUrl = location.href;
setInterval(() => {
    if (location.href !== lastUrl) {
        lastUrl = location.href;
        console.log("[YT-EXT] Phát hiện đổi URL (Polling), đang chuẩn bị lọc lại...");
        // Delay nhẹ 500ms để chờ Youtube Render sơ bộ nội dung mới
        setTimeout(fullReset, 500); 
    }
}, 1000);

// ==========================================
// CORE LOGIC HỖ TRỢ
// ==========================================

function parseConfig(rawConfig) {
    return {
        quality: rawConfig.quality,
        minLen: rawConfig.minLen,
        maxLen: rawConfig.maxLen,
        checkViews: rawConfig.checkViews,
        minView: parseViewsStr(rawConfig.minViewFormat),
        checkTime: rawConfig.checkTime,
        maxDays: rawConfig.maxDays,
        maxCount: rawConfig.maxCount || 0
    };
}

function resetProcessedItems() {
    // Xóa bỏ tất cả overlay tự động
    document.querySelectorAll('.yt-ext-overlay').forEach(el => el.remove());
    
    // Xóa bỏ tất cả dấu vết chọn thủ công trên UI
    document.querySelectorAll('.yt-ext-manual-selected').forEach(el => {
        el.classList.remove('yt-ext-manual-selected');
    });

    // Reset trạng thái xử lý trên các element renderer
    document.querySelectorAll('[data-yt-ext-processed]').forEach(el => {
        delete el.dataset.ytExtProcessed;
        delete el.dataset.ytExtUrl;
    });
}

function parseDurationStr(timeStr) {
    if (!timeStr) return 0;
    const parts = timeStr.trim().split(':').map(Number);
    if (parts.length === 2) {
        return parts[0] * 60 + parts[1];
    } else if (parts.length === 3) {
        return parts[0] * 3600 + parts[1] * 60 + parts[2];
    }
    return 0;
}

function parseViewsStr(viewStr) {
    if (!viewStr) return 0;
    let numStr = viewStr.replace(/[^0-9.KMB]/gi, '').toUpperCase();
    let multiplier = 1;
    if (numStr.includes('K')) { multiplier = 1000; numStr = numStr.replace('K', ''); }
    else if (numStr.includes('M')) { multiplier = 1000000; numStr = numStr.replace('M', ''); }
    else if (numStr.includes('B')) { multiplier = 1000000000; numStr = numStr.replace('B', ''); }
    return parseFloat(numStr) * multiplier;
}

function parseTimeAgoStr(timeAgoStr) {
    if (!timeAgoStr) return 999999;
    let str = timeAgoStr.toLowerCase();
    const numMatches = str.match(/[0-9]+/);
    if (!numMatches) return 999999;
    let num = parseInt(numMatches[0]);

    if (str.includes('minute') || str.includes('hour') || str.includes('second')) return 0;
    if (str.includes('day')) return num;
    if (str.includes('week')) return num * 7;
    if (str.includes('month')) return num * 30;
    if (str.includes('year')) return num * 365;
    return 999999;
}

// Hàm duyệt tìm video
function processVideos() {
    // Nếu maxCount bằng 0 -> TẮT TÍNH NĂNG TỰ ĐỘNG QUÉT
    if (currentConfig.maxCount === 0) {
        return; 
    }

    // Nếu đạt giới hạn cấu hình Max, Không duyệt tìm kiếm video mới nữa
    if (validFoundCount >= currentConfig.maxCount) {
        return; 
    }

    const videoSelectors = [
        'ytd-rich-item-renderer',
        'ytd-video-renderer',
        'ytd-grid-video-renderer',
        'ytd-compact-video-renderer'
    ];

    const items = document.querySelectorAll(videoSelectors.join(', '));

    items.forEach(item => {
        // Chặn sớm trong loop
        if (currentConfig.maxCount === 0 || validFoundCount >= currentConfig.maxCount) return;

        try {
            let titleEl = item.querySelector('a#video-title, a#video-title-link');
            if (!titleEl) return;
            let url = titleEl.href;
            if (!url || url.includes('/shorts/')) return;

            // KIỂM TRA TÁI SỬ DỤNG RENDERER (Youtube SPA)
            // Nếu Element này đã được quét cho video khác rồi, cần reset để quét lại URL mới
            if (item.dataset.ytExtProcessed === "true" && item.dataset.ytExtUrl === url) {
                return;
            }

            // Dọn dẹp Overlay cũ (nếu có) carried over từ tab trước
            let oldOverlay = item.querySelector('.yt-ext-overlay');
            if (oldOverlay) oldOverlay.remove();

            // QUAN TRỌNG: Dọn dẹp dấu hiệu chọn thủ công nếu Video đã thay đổi trên Element này
            let thumbnail = item.querySelector('ytd-thumbnail');
            if (thumbnail && thumbnail.classList.contains('yt-ext-manual-selected')) {
                thumbnail.classList.remove('yt-ext-manual-selected');
                manuallySelectedItems.delete(thumbnail);
                
                // Cập nhật lại Toast nếu đang ở Manual Mode
                if (isManualSelectionMode) {
                    showToast(`Giỏ hàng: ${manuallySelectedItems.size} video thủ công.\n(Nhấn ENTER để Tải)`, 0);
                }
            }

            let thumbnailOverlayTime = item.querySelector('ytd-thumbnail-overlay-time-status-renderer #text');
            let durationStr = thumbnailOverlayTime ? thumbnailOverlayTime.textContent.trim() : "0:00";
            let durationSec = parseDurationStr(durationStr);

            let metadataLines = item.querySelectorAll('#metadata-line span.inline-metadata-item');
            let viewsStr = "", timeAgoStr = "";
            if (metadataLines.length >= 2) {
                viewsStr = metadataLines[0].textContent;
                timeAgoStr = metadataLines[1].textContent;
            } else if (metadataLines.length === 1) {
                viewsStr = metadataLines[0].textContent;
            }

            let views = parseViewsStr(viewsStr);
            let daysAgo = parseTimeAgoStr(timeAgoStr);
            let isValid = true;
            let rejectReasons = [];

            let durationMin = durationSec / 60;
            if (durationMin < currentConfig.minLen || durationMin > currentConfig.maxLen) {
                isValid = false;
                rejectReasons.push(`Dài ${Math.round(durationMin)}m`);
            }

            if (currentConfig.checkViews && views < currentConfig.minView) {
                isValid = false;
                rejectReasons.push(`Thiếu View (${viewsStr.trim()})`);
            }

            if (currentConfig.checkTime && daysAgo > currentConfig.maxDays) {
                isValid = false;
                rejectReasons.push(`Quá Cũ (${daysAgo} ngày)`);
            }

            // --- TẠO OVERLAY CHO TẤT CẢ CÁC VIDEO (Dù hợp lệ hay không) ---
            // thumbnail đã được declare ở trên rồi, chỉ cần dùng lại
            if (thumbnail) {
                const overlay = document.createElement('div');
                // Gắn thêm class để phân biệt màu sắc
                overlay.className = 'yt-ext-overlay ' + (isValid ? 'is-valid' : 'is-invalid');

                // --- CỘT TRÁI (LEFT AREA) ---
                const leftArea = document.createElement('div');
                leftArea.className = 'yt-ext-left-area';

                // Dòng 1: Checkbox + Quality
                const topLeft = document.createElement('div');
                topLeft.className = 'yt-ext-top-left';

                const mainCheckbox = document.createElement('input');
                mainCheckbox.type = 'checkbox';
                mainCheckbox.className = 'yt-ext-checkbox';
                // TỰ ĐỘNG TÍCH nếu video Hợp Lệ (isValid)
                mainCheckbox.checked = isValid; 

                const qualityTag = document.createElement('div');
                qualityTag.className = 'yt-ext-quality-tag';
                qualityTag.innerText = (currentConfig.quality || '1080') + 'P';

                topLeft.appendChild(mainCheckbox);
                topLeft.appendChild(qualityTag);
                leftArea.appendChild(topLeft);

                // Các dòng thông tin tiếp theo
                const createInfoLine = (icon, text) => {
                    const line = document.createElement('div');
                    line.className = 'yt-ext-info-item';
                    line.innerHTML = `<span>${icon}</span> <span>${text}</span>`;
                    return line;
                };

                leftArea.appendChild(createInfoLine('👁️', viewsStr.trim()));
                leftArea.appendChild(createInfoLine('🕒', durationStr));
                leftArea.appendChild(createInfoLine('📅', timeAgoStr.trim()));

                overlay.appendChild(leftArea);

                // --- GÓC PHẢI TRÊN (RIGHT TOP) ---
                const rightTop = document.createElement('div');
                rightTop.className = 'yt-ext-right-top';

                const dlBtn = document.createElement('button');
                dlBtn.className = 'yt-ext-dl-btn-small';
                dlBtn.innerHTML = '⬇️';
                dlBtn.title = "Tải video này";

                rightTop.appendChild(dlBtn);
                overlay.appendChild(rightTop);

                // --- GÓC PHẢI DƯỚI (OPACITY CONTROL) ---
                const opacityCtrl = document.createElement('div');
                opacityCtrl.className = 'yt-ext-opacity-control';
                opacityCtrl.innerHTML = `<span>Bỏ Opacity</span>`;

                const opacityToggle = document.createElement('input');
                opacityToggle.type = 'checkbox';
                opacityToggle.className = 'yt-ext-opacity-toggle';
                
                opacityCtrl.appendChild(opacityToggle);
                overlay.appendChild(opacityCtrl);

                thumbnail.appendChild(overlay);

                // --- LOGIC TƯƠNG TÁC ---
                
                // Nút download đơn lẻ
                dlBtn.addEventListener('click', (e) => {
                    e.preventDefault(); e.stopPropagation();
                    sendDownloadRequest(url, currentConfig.quality, dlBtn);
                    
                    if (mainCheckbox.checked) {
                        mainCheckbox.checked = false;
                        bulkDownloadItems.delete(url);
                    }
                });

                // Checkbox chọn hàng loạt
                // Nếu video Valid -> Cho sẵn vào Map Bulk Download
                if (isValid) {
                    bulkDownloadItems.set(url, dlBtn); 
                    validFoundCount++;
                }

                mainCheckbox.addEventListener('change', () => {
                    if (mainCheckbox.checked) {
                        bulkDownloadItems.set(url, dlBtn);
                    } else {
                        bulkDownloadItems.delete(url);
                    }
                });

                // Toggle mờ thông tin (Bỏ Opacity)
                opacityToggle.addEventListener('change', () => {
                    if (opacityToggle.checked) {
                        overlay.classList.add('fade-info');
                    } else {
                        overlay.classList.remove('fade-info');
                    }
                });
            }
            // Đánh dấu đã xử lý theo đúng URL này
            item.dataset.ytExtProcessed = "true";
            item.dataset.ytExtUrl = url;
        } catch (err) { }
    });
}

function sendDownloadRequest(url, quality, btnElement) {
    if (btnElement) {
        btnElement.innerText = '⏳ ĐANG GỬI...';
        btnElement.style.background = '#eab308';
        btnElement.disabled = true;
    }

    fetch('http://127.0.0.1:8000/api/download', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: url, quality: quality, output_dir: "Downloads" })
    })
        .then(res => {
            if (!res.ok) throw new Error("HTTP error " + res.status);
            return res.json();
        })
        .then(data => {
            if (btnElement) {
                btnElement.innerText = '✅ VÀO HÀNG ĐỢI';
                btnElement.style.background = '#22c55e';
            }
        })
        .catch(err => {
            console.error("Lỗi:", err);
            if (btnElement) {
                btnElement.innerText = '❌ LỖI GỬI SERVER';
                btnElement.style.background = '#ef4444';
                btnElement.disabled = false;
            }
        });
}

// =========================================================
// CHẾ ĐỘ CHỌN THỦ CÔNG (MANUAL SELECTION MODE)
// =========================================================

let isManualSelectionMode = false;
let manuallySelectedItems = new Map(); // Link element thumbnail => URL video

document.addEventListener('keydown', (e) => {
    // Nhấn Alt + S để Ép quét lại toàn bộ trang (Dùng khi đổi Tab mà chưa thấy kết quả)
    if (e.altKey && (e.code === 'KeyS' || e.key.toLowerCase() === 's')) {
        e.preventDefault();
        showToast("🔍 Đang Ép Quét lại toàn bộ video trên trang...", 2000);
        fullReset();
    }

    // Nhấn Alt + T để Bật/Tắt chế độ Manual Mode
    if (e.altKey && (e.code === 'KeyT' || e.key.toLowerCase() === 't')) {
        e.preventDefault();
        toggleManualMode();
    }

    // Nhấn ENTER để gửi nạp (Khi đang bật Manual Mode)
    if (isManualSelectionMode && e.code === 'Enter') {
        e.preventDefault();
        submitManualSelection();
    }

    // Nhấn ESC để Hủy Manual Mode
    if (isManualSelectionMode && e.code === 'Escape') {
        e.preventDefault();
        disableManualMode();
        showToast("Đã Hủy chế độ Chọn Thủ Công.");
    }
});

function toggleManualMode() {
    if (isManualSelectionMode) {
        disableManualMode();
        showToast("Đã TẮT C.độ Chọn Thủ Công.", 2000);
    } else {
        enableManualMode();
    }
}

function enableManualMode() {
    isManualSelectionMode = true;
    manuallySelectedItems.clear();
    document.body.classList.add('yt-ext-manual-mode');
    showToast("🖱️ CHẾ ĐỘ CHỌN THỦ CÔNG: BẬT\nClick chuột vào Thumbnail để chốt đơn.\nNhấn ENTER để Tải tất cả đã chọn.\nNhấn ESC để Hủy.", 0);
}

function disableManualMode() {
    isManualSelectionMode = false;
    document.body.classList.remove('yt-ext-manual-mode');

    manuallySelectedItems.forEach((url, thumbnailEl) => {
        thumbnailEl.classList.remove('yt-ext-manual-selected');
    });
    manuallySelectedItems.clear();

    let t = document.getElementById('yt-ext-toast');
    if (t && t.timer === undefined && !t.innerText.includes('Đã Gửi') && !t.innerText.includes('Tắt')) {
        t.classList.remove('show');
    }
}

function submitManualSelection() {
    if (manuallySelectedItems.size === 0) {
        showToast("⚠️ Cảnh báo: Bạn chưa click chọn video nào!", 3000);
        return;
    }

    let count = 0;
    manuallySelectedItems.forEach((url, thumbnailEl) => {
        let quality = currentConfig && currentConfig.quality ? currentConfig.quality : '1080';
        sendDownloadRequest(url, quality, null);
        count++;
    });

    showToast(`🚀 XONG! Đã đẩy ${count} video Thủ công vào Máy chủ tải`, 5000);
    disableManualMode();
}

document.addEventListener('click', (e) => {
    if (!isManualSelectionMode) return;

    let container = e.target.closest('ytd-rich-item-renderer, ytd-video-renderer, ytd-grid-video-renderer, ytd-compact-video-renderer');

    if (container) {
        e.preventDefault();
        e.stopPropagation();

        let thumbnail = container.querySelector('ytd-thumbnail');
        let titleEl = container.querySelector('a#video-title, a#video-title-link');

        if (!thumbnail || !titleEl) return;
        let url = titleEl.href;

        if (manuallySelectedItems.has(thumbnail)) {
            manuallySelectedItems.delete(thumbnail);
            thumbnail.classList.remove('yt-ext-manual-selected');
        } else {
            manuallySelectedItems.set(thumbnail, url);
            thumbnail.classList.add('yt-ext-manual-selected');
        }

        if (isManualSelectionMode) {
            showToast(`Giỏ hàng: ${manuallySelectedItems.size} video thủ công.\n(Nhấn ENTER để Tải)`, 0);
        }
    }
}, true);
