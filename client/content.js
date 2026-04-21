let currentConfig = {
    quality: '1080', minLen: 0, maxLen: 60, checkViews: true, minView: 100000, checkTime: true, maxDays: 30, maxCount: 0
};
let validFoundCount = 0;
let scanInterval = null;
let bulkDownloadItems = new Map(); // Link Element Youtube => Nút bấm Button để auto nhấn
let videoQualitiesCache = new Map(); // Cache lưu quality từ server: URL => [2160, 1080, ...]

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
        bulkDownloadItems.forEach((data, url) => {
            // Kiểm tra data.btn (nút download) có sẵn sàng không
            if (data.btn && !data.btn.disabled) {
                const quality = data.select ? data.select.value : (currentConfig.quality || '1080');
                sendDownloadRequest(url, quality, data.btn);
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
        checkQuality: rawConfig.checkQuality !== undefined ? rawConfig.checkQuality : true,
        quality: rawConfig.quality,
        checkLen: rawConfig.checkLen !== undefined ? rawConfig.checkLen : true,
        minLen: rawConfig.minLen,
        maxLen: rawConfig.maxLen,
        checkViews: rawConfig.checkViews,
        minView: parseViewsStr(rawConfig.minViewFormat),
        checkTime: rawConfig.checkTime,
        maxDays: rawConfig.maxDays,
        checkAuto: rawConfig.checkAuto !== undefined ? rawConfig.checkAuto : false,
        maxCount: rawConfig.maxCount || 0,
        onlyValid: rawConfig.onlyValid || false
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

    // Xóa bỏ class hỗ trợ overflow trên thumbnail
    document.querySelectorAll('.yt-ext-thumbnail-container').forEach(el => {
        el.classList.remove('yt-ext-thumbnail-container');
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

async function fetchVideoQualitiesFromClient(url, qualitySelect) {
    if (qualitySelect.dataset.loading === "true" || qualitySelect.dataset.fetched === "true") return;

    if (videoQualitiesCache.has(url)) {
        updateQualityDropdown(qualitySelect, videoQualitiesCache.get(url));
        qualitySelect.dataset.fetched = "true";
        return;
    }

    console.log("[YT-EXT] Fetching video qualities from Client (YouTube HTML) for URL:", url);

    const oldHTML = qualitySelect.innerHTML;
    qualitySelect.innerHTML = '<option value="">⏳...</option>';
    qualitySelect.dataset.loading = "true";
    qualitySelect.classList.add('loading');
    qualitySelect.disabled = true;

    try {
        const response = await fetch(url);
        if (!response.ok) throw new Error("Fetch failed");
        const html = await response.text();

        const regex = /ytInitialPlayerResponse\s*=\s*({.+?});/;
        const match = html.match(regex);

        if (match) {
            const data = JSON.parse(match[1]);
            const streamingData = data.streamingData;
            if (streamingData && streamingData.adaptiveFormats) {
                const heights = streamingData.adaptiveFormats
                    .map(item => item.height)
                    .filter(h => h !== undefined);
                const uniqueQualities = [...new Set(heights)].sort((a, b) => b - a);

                if (uniqueQualities.length > 0) {
                    console.log("[YT-EXT] Đã lấy được quality từ Client:", uniqueQualities);
                    videoQualitiesCache.set(url, uniqueQualities);
                    updateQualityDropdown(qualitySelect, uniqueQualities);
                    qualitySelect.dataset.fetched = "true";
                    return;
                }
            }
        }
        throw new Error("Data not found");
    } catch (err) {
        console.warn("[YT-EXT] Lỗi khi lấy chất lượng từ Client:", err);
    } finally {
        qualitySelect.dataset.loading = "false";
        qualitySelect.classList.remove('loading');
        qualitySelect.disabled = false;
        if (qualitySelect.dataset.fetched !== "true") {
            qualitySelect.innerHTML = oldHTML;
        }
    }
}

function updateQualityDropdown(select, qualities) {
    const currentVal = select.value;
    select.innerHTML = '';

    qualities.forEach(q => {
        const opt = document.createElement('option');
        opt.value = q.toString();
        opt.textContent = q + (typeof q === 'number' || !isNaN(q) ? 'P' : '');

        // Ưu tiên giữ lại giá trị đang chọn hoặc theo config
        let targetQuality = currentVal || currentConfig.quality || '1080';
        if (q.toString() === targetQuality.toString()) {
            opt.selected = true;
        }
        select.appendChild(opt);
    });

    // Nếu sau khi update mà không có cái nào được select, chọn cái đầu tiên (thường là cao nhất)
    if (select.selectedIndex === -1 && select.options.length > 0) {
        select.selectedIndex = 0;
    }
}

let isScanning = false;

// Hàm duyệt tìm video (Đã chuyển sang Async để thực hiện check tuần tự)
async function processVideos() {
    if (isScanning) return;
    isScanning = true;

    try {
        const videoSelectors = [
            'ytd-rich-item-renderer',
            'ytd-video-renderer',
            'ytd-grid-video-renderer',
            'ytd-compact-video-renderer'
        ];

        const items = document.querySelectorAll(videoSelectors.join(', '));

        for (const item of items) {
            try {
                let titleEl = item.querySelector('a#video-title, a#video-title-link');
                if (!titleEl) continue;
                let url = titleEl.href;
                if (!url || url.includes('/shorts/')) continue;

                // KIỂM TRA TÁI SỬ DỤNG RENDERER
                if (item.dataset.ytExtProcessed === "true" && item.dataset.ytExtUrl === url) {
                    continue;
                }

                // --- BƯỚC 1: LỌC SETTING (VIEW, TIME, LEN) ---
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
                if (currentConfig.checkLen && (durationMin < currentConfig.minLen || durationMin > currentConfig.maxLen)) {
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

                let meetsRequirements = isValid; 

                // --- BƯỚC 2: KIỂM TRA HISTORY (SEQUENTIAL WAIT) ---
                let isInHistory = false;
                
                // Trích xuất Video ID chính xác hơn bằng Regex
                let videoId = "";
                const vidMatch = url.match(/(?:v=|\/)([0-9A-Za-z_-]{11})/);
                if (vidMatch) {
                    videoId = vidMatch[1];
                } else {
                    videoId = url.split('v=')[1]?.split('&')[0] || url.split('/').pop();
                }

                if (videoId) {
                    try {
                        const hRes = await fetch(`http://127.0.0.1:8000/api/check_history?video_id=${videoId}`);
                        const hData = await hRes.json();
                        isInHistory = hData.downloaded;
                    } catch (e) {
                        console.warn("[YT-EXT] Check history fetch failed for ID:", videoId, e);
                    }
                }

                // Logic "Nhường Slot": Nếu đã tải rồi thì không còn Valid để auto-fetch nữa
                if (meetsRequirements && isInHistory) {
                    isValid = false;
                    // meetsRequirements vẫn giữ nguyên là true để video không bị ẩn bởi chế độ onlyValid
                    rejectReasons.push("Downloaded");
                }

                // Kiểm tra ĐỊNH MỨC QUÉT TỰ ĐỘNG
                if (!currentConfig.checkAuto) {
                    isValid = false;
                } else if (isValid && currentConfig.maxCount > 0 && validFoundCount >= currentConfig.maxCount) {
                    isValid = false;
                    rejectReasons.push(`Đã đạt Max (${currentConfig.maxCount})`);
                }

                // --- BƯỚC 3: DỰNG GIAO DIỆN ---
                let thumbnail = item.querySelector('ytd-thumbnail');
                if (thumbnail) {
                    // Cleanup
                    let oldOverlay = item.querySelector('.yt-ext-overlay');
                    if (oldOverlay) oldOverlay.remove();
                    if (thumbnail.classList.contains('yt-ext-manual-selected')) {
                        thumbnail.classList.remove('yt-ext-manual-selected');
                        manuallySelectedItems.delete(thumbnail);
                    }

                    // Mode OnlyValid
                    if (currentConfig.onlyValid && !meetsRequirements) {
                        item.dataset.ytExtProcessed = "true";
                        item.dataset.ytExtUrl = url;
                        continue;
                    }

                    thumbnail.classList.add('yt-ext-thumbnail-container');
                    const overlay = document.createElement('div');
                    let overlayClass = 'yt-ext-overlay ';
                    if (isValid) {
                        overlayClass += 'is-valid item-selected';
                    } else {
                        overlayClass += 'is-invalid item-unselected';
                    }
                    if (isInHistory) {
                        overlayClass += ' is-downloaded-item';
                    }
                    overlay.className = overlayClass;

                    // NHÃN TRẠNG THÁI
                    const hashtag = document.createElement('div');
                    hashtag.className = 'yt-ext-hashtag';
                    hashtag.style.color = 'white'; // Đảm bảo chữ luôn trắng
                    hashtag.style.zIndex = '100';  // Đảm bảo nổi lên trên cùng

                    if (isInHistory) {
                        hashtag.innerText = 'Downloaded';
                        hashtag.style.backgroundColor = 'rgba(107, 114, 128, 0.9)'; // Màu xám
                        hashtag.classList.add('is-downloaded');
                    } else {
                        hashtag.innerText = '#READY';
                        hashtag.style.backgroundColor = 'rgba(34, 197, 94, 0.9)'; // Màu xanh
                    }
                    if (isValid || isInHistory) overlay.appendChild(hashtag);

                    // THÔNG TIN
                    const leftArea = document.createElement('div');
                    leftArea.className = 'yt-ext-left-area';
                    const topLeft = document.createElement('div');
                    topLeft.className = 'yt-ext-top-left';

                    const mainCheckbox = document.createElement('input');
                    mainCheckbox.type = 'checkbox';
                    mainCheckbox.className = 'yt-ext-checkbox';
                    mainCheckbox.checked = isValid;

                    const qualitySelect = document.createElement('select');
                    qualitySelect.className = 'yt-ext-quality-select';
                    const opt = document.createElement('option');
                    opt.value = "";
                    opt.textContent = isValid ? "⏳..." : "Quality";
                    qualitySelect.appendChild(opt);

                    topLeft.appendChild(mainCheckbox);
                    topLeft.appendChild(qualitySelect);
                    leftArea.appendChild(topLeft);

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

                    // Nút download nhanh
                    const rightTop = document.createElement('div');
                    rightTop.className = 'yt-ext-right-top';
                    const dlBtn = document.createElement('button');
                    dlBtn.className = 'yt-ext-dl-btn-small';
                    dlBtn.innerHTML = '⬇️';
                    rightTop.appendChild(dlBtn);
                    overlay.appendChild(rightTop);

                    // Opacity
                    const opacityCtrl = document.createElement('div');
                    opacityCtrl.className = 'yt-ext-opacity-control';
                    opacityCtrl.innerHTML = `<span>Bỏ Opacity</span>`;
                    const opacityToggle = document.createElement('input');
                    opacityToggle.type = 'checkbox';
                    opacityToggle.className = 'yt-ext-opacity-toggle';
                    opacityCtrl.appendChild(opacityToggle);
                    overlay.appendChild(opacityCtrl);

                    thumbnail.appendChild(overlay);

                    // Events
                    qualitySelect.addEventListener('mousedown', (e) => {
                        if (qualitySelect.dataset.fetched !== "true" && qualitySelect.dataset.loading !== "true") {
                            e.preventDefault();
                            fetchVideoQualitiesFromClient(url, qualitySelect);
                        }
                    });

                    // --- BƯỚC 4: LOAD QUALITY (NẾU READY) ---
                    if (isValid) {
                        fetchVideoQualitiesFromClient(url, qualitySelect);
                    }

                    const updateSelectionStatus = (selected) => {
                        if (selected) {
                            overlay.classList.add('item-selected');
                            overlay.classList.remove('item-unselected');
                        } else {
                            overlay.classList.remove('item-selected');
                            overlay.classList.add('item-unselected');
                        }
                    };

                    dlBtn.addEventListener('click', (e) => {
                        e.preventDefault(); e.stopPropagation();
                        sendDownloadRequest(url, qualitySelect.value, dlBtn);
                        if (mainCheckbox.checked) {
                            mainCheckbox.checked = false;
                            bulkDownloadItems.delete(url);
                            updateSelectionStatus(false);
                        }
                    });

                    if (isValid) {
                        bulkDownloadItems.set(url, { btn: dlBtn, select: qualitySelect });
                        validFoundCount++;
                    }

                    mainCheckbox.addEventListener('change', () => {
                        const isChecked = mainCheckbox.checked;
                        updateSelectionStatus(isChecked);
                        if (isChecked) {
                            bulkDownloadItems.set(url, { btn: dlBtn, select: qualitySelect });
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
            } catch (innerErr) {
                console.warn("[YT-EXT] Lỗi video đơn lẻ:", innerErr);
            }
        }
    } catch (err) {
        console.error("[YT-EXT] Lỗi quét chính:", err);
    } finally {
        isScanning = false;
    }
}

function sendDownloadRequest(url, quality, btnElement) {
    // Không thay đổi trạng thái nút bấm ở đây nữa theo yêu cầu - Giữ nguyên giao diện
    
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
            // Cập nhật nhãn "Downloaded" ngay lập tức trên UI (Optimistic Update)
            updateUIDownloaded(url, btnElement);
        })
        .catch(err => {
            console.error("[YT-EXT] Lỗi gửi yêu cầu download:", err);
        });
}

/**
 * Cập nhật giao diện sang trạng thái "Downloaded" ngay lập tức
 */
function updateUIDownloaded(url, btnElement) {
    let overlay = null;
    if (btnElement) {
        overlay = btnElement.closest('.yt-ext-overlay');
    } else {
        // Tìm overlay dựa trên URL (dùng cho Manual Selection)
        const container = document.querySelector(`[data-yt-ext-url="${url}"]`);
        if (container) {
            overlay = container.querySelector('.yt-ext-overlay');
        }
    }

    if (overlay) {
        // Chuyển trạng thái overlay sang unselected (nhường slot)
        overlay.classList.remove('is-valid', 'item-selected');
        overlay.classList.add('is-invalid', 'item-unselected', 'is-downloaded-item');

        // Cập nhật nhãn Hashtag
        let hashtag = overlay.querySelector('.yt-ext-hashtag');
        if (!hashtag) {
            hashtag = document.createElement('div');
            hashtag.className = 'yt-ext-hashtag';
            hashtag.style.color = 'white';
            hashtag.style.zIndex = '100';
            overlay.appendChild(hashtag);
        }
        
        hashtag.innerText = 'Downloaded';
        hashtag.style.backgroundColor = 'rgba(107, 114, 128, 0.9)';
        hashtag.classList.add('is-downloaded');

        // Bỏ chọn checkbox
        const cb = overlay.querySelector('.yt-ext-checkbox');
        if (cb) cb.checked = false;
        
        // Xóa khỏi danh sách chờ bulk download
        bulkDownloadItems.delete(url);
    }
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
        // Tìm chất lượng chọn ở overlay (nếu video đã được scan dán overlay)
        let downloadQuality = currentConfig && currentConfig.quality ? currentConfig.quality : '1080';

        const qSelect = thumbnailEl.querySelector('.yt-ext-quality-select');
        if (qSelect) {
            downloadQuality = qSelect.value;
        }

        sendDownloadRequest(url, downloadQuality, null);
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
