let currentConfig = {
    quality: '1080', minLen: 0, maxLen: 60, checkViews: true, minView: 100000, checkTime: true, maxDays: 30, maxCount: 0
};

// Hệ thống quản lý trạng thái phiên quét (State Object)
let scanState = {
    version: 0,
    validFoundCount: 0,
    bulkDownloadItems: new Map() // Link Element Youtube => Nút bấm Button
};

let videoQualitiesCache = new Map(); // Cache lưu quality từ server: URL => [2160, 1080, ...]
let scanInterval;

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
function startScanning(windowId) {
    const configKeys = ['ytConfig'];
    if (windowId) configKeys.push(`ytConfig_${windowId}`);

    chrome.storage.local.get(configKeys, (data) => {
        const config = (windowId && data[`ytConfig_${windowId}`]) || data.ytConfig;
        if (config) {
            currentConfig = parseConfig(config);
            if (currentConfig.directMode) {
                initFloatingWidget();
            }
        }
        // Ghim lặp liên tục mỗi 2s để đắp giao diện (Chỉ trên YouTube)
        if (window.location.hostname.includes("youtube.com")) {
            if (scanInterval) clearInterval(scanInterval);
            scanInterval = setInterval(processVideos, 2000);
            console.log(`[YT-EXT] Đã bắt đầu quét nền (WindowID: ${windowId || 'Global'})`);
        }
    });
}

// Cố gắng lấy Window ID từ background (Cần reload extension để background.js hoạt động)
try {
    chrome.runtime.sendMessage({ action: "GET_WINDOW_ID" }, (response) => {
        const windowId = response ? response.windowId : null;
        startScanning(windowId);
    });
} catch (e) {
    // Nếu chưa reload extension, background.js sẽ chưa sẵn sàng -> dùng fallback
    console.warn("[YT-EXT] Background script chưa sẵn sàng, dùng cấu hình mặc định.");
    startScanning(null);
}


// Lắng nghe lệnh từ Popup truyền đi (như Đổi Option hay Bấm Bulk Tải)
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === "UPDATE_CONFIG") {
        const newConfig = parseConfig(request.config);
        const needsReset = JSON.stringify({ ...currentConfig, directMode: null }) !== JSON.stringify({ ...newConfig, directMode: null });
        currentConfig = newConfig;
        if (currentConfig.directMode) {
            initFloatingWidget();
        } else {
            removeFloatingWidget();
        }
        if (needsReset) {
            fullReset();
            showToast("🔄 Đã cập nhật bộ lọc video!", 2500);
        }
        sendResponse({ status: "ok" });
    } else if (request.action === "BULK_DOWNLOAD") {
        let count = 0;
        scanState.bulkDownloadItems.forEach((data, url) => {
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

async function fullReset() {
    scanState = {
        version: scanState.version + 1,
        validFoundCount: 0,
        bulkDownloadItems: new Map()
    };

    while (isScanning) {
        await new Promise(r => setTimeout(r, 50));
    }

    resetProcessedItems();

    manuallySelectedItems.clear();
    if (isManualSelectionMode) {
        showToast(`Giỏ hàng: 0 video thủ công.\n(Nhấn ENTER để Tải)`, 0);
    }

    processVideos();
}

// Hàm lấy "dấu vân tay" của nội dung hiện tại (dựa trên 3 video đầu tiên)
function getContentFingerprint() {
    const selectors = [
        'ytd-rich-item-renderer',
        'ytd-video-renderer',
        'ytd-grid-video-renderer',
        'ytd-compact-video-renderer'
    ];
    const items = document.querySelectorAll(selectors.join(', '));
    let fingerprint = "";
    for (let i = 0; i < Math.min(items.length, 3); i++) {
        let a = items[i].querySelector('a#video-title, a#video-title-link, a.shortsLockupViewModelHostOutsideMetadataEndpoint');
        if (a && a.href) fingerprint += a.href;
    }
    return fingerprint;
}

// Bắt sự kiện chuyển hướng trang của YouTube (Single Page App)
if (window.location.hostname.includes("youtube.com")) {
    // Cơ chế Polling URL và Nội dung (Fingerprinting)
    let lastUrl = location.href;
    let lastFingerprint = getContentFingerprint();

    window.addEventListener('yt-navigate-finish', () => {
        console.log("[YT-EXT] Phát hiện chuyển trang (Event), đang làm mới bộ lọc...");
        lastUrl = location.href;
        lastFingerprint = getContentFingerprint();
        fullReset();
    });

    setInterval(() => {
        const currentUrl = location.href;
        const currentFingerprint = getContentFingerprint();

        const urlChanged = currentUrl !== lastUrl;
        // Chỉ coi là đổi nội dung nếu fingerprint hiện tại không rỗng và khác với cái cũ
        const contentChanged = currentFingerprint !== "" && currentFingerprint !== lastFingerprint;

        if (urlChanged || contentChanged) {
            // HỦY DIỆT PHIÊN QUÉT CŨ (Bằng cách tạo một hồ sơ mới ngay lập tức)
            scanState = {
                version: scanState.version + 1,
                validFoundCount: 0,
                bulkDownloadItems: new Map()
            };
            isScanning = false;

            lastUrl = currentUrl;
            lastFingerprint = currentFingerprint;

            console.log(`[YT-EXT] Phát hiện thay đổi ${urlChanged ? 'URL' : 'Nội dung'}, đang làm mới bộ lọc...`);
            // Delay nhẹ 500ms để chờ Youtube Render sơ bộ nội dung mới
            setTimeout(fullReset, 500);
        }
    }, 2000);
}

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
        onlyValid: rawConfig.onlyValid || false,
        directMode: rawConfig.directMode || false
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
    // Bật/tắt toàn bộ quá trình scan dựa trên Auto-Scan
    if (!currentConfig.checkAuto) return;

    if (isScanning) return;
    isScanning = true;

    const myState = scanState; // "Bắt" lấy hồ sơ phiên quét tại thời điểm này

    try {
        const videoSelectors = [
            'ytd-rich-item-renderer',
            'ytd-video-renderer',
            'ytd-grid-video-renderer',
            'ytd-compact-video-renderer'
        ];

        const items = document.querySelectorAll(videoSelectors.join(', '));
        let itemIndex = 0;

        for (const item of items) {
            itemIndex++;
            // KIỂM TRA PHIÊN QUÉT: Nếu đã có hồ sơ mới, dừng ngay luồng này
            if (myState !== scanState) {
                console.log("[YT-EXT] Luồng quét cũ đã dừng hẳn.");
                return;
            }

            try {
                let titleEl = item.querySelector('a#video-title, a#video-title-link, a.shortsLockupViewModelHostOutsideMetadataEndpoint');
                if (!titleEl) continue;
                let url = titleEl.href;
                if (!url) continue;

                // KIỂM TRA TÁI SỬ DỤNG RENDERER
                if (item.dataset.ytExtProcessed === "true" && item.dataset.ytExtUrl === url) {
                    continue;
                }

                let isShort = url.includes('/shorts/');

                // --- BƯỚC 1: LỌC SETTING (VIEW, TIME, LEN) ---
                let thumbnailOverlayTime = item.querySelector('ytd-thumbnail-overlay-time-status-renderer #text');
                let durationStr = thumbnailOverlayTime ? thumbnailOverlayTime.textContent.trim() : "0:00";
                let durationSec = parseDurationStr(durationStr);

                let viewsStr = "", timeAgoStr = "";

                if (isShort) {
                    let shortViewEl = item.querySelector('.shortsLockupViewModelHostOutsideMetadataSubhead span');
                    if (shortViewEl) {
                        viewsStr = shortViewEl.textContent;
                    }
                } else {
                    let metadataLines = item.querySelectorAll('#metadata-line span.inline-metadata-item');
                    if (metadataLines.length >= 2) {
                        viewsStr = metadataLines[0].textContent;
                        timeAgoStr = metadataLines[1].textContent;
                    } else if (metadataLines.length === 1) {
                        viewsStr = metadataLines[0].textContent;
                    }
                }

                let views = parseViewsStr(viewsStr);
                let daysAgo = parseTimeAgoStr(timeAgoStr);

                // KIỂM TRA DỮ LIỆU SẴN SÀNG (Cơ chế Dừng và Chờ để bảo toàn thứ tự)
                let isMissingData = false;
                if (currentConfig.checkViews && !viewsStr) isMissingData = true;
                if (!isShort && currentConfig.checkTime && !timeAgoStr) isMissingData = true;

                if (isMissingData) {
                    let waitCount = parseInt(item.dataset.ytExtWaitCount || 0);
                    if (waitCount < 5) { // Chờ tối đa 5 chu kỳ quét (mỗi chu kỳ 2s => ~10 giây)
                        item.dataset.ytExtWaitCount = waitCount + 1;
                        // console.log(`[YT-EXT] Đang chờ dữ liệu video (${waitCount + 1}/5)...`);
                        break; // DỪNG TOÀN BỘ vòng lặp để bảo toàn thứ tự ưu tiên
                    } else {
                        console.warn("[YT-EXT] Quá thời gian chờ dữ liệu (10s), bỏ qua video này để khai thông hàng đợi.");
                        // Sau 10s không thấy dữ liệu thì cho phép đi tiếp (thường sẽ bị loại vì View = 0)
                    }
                }

                let isValid = true;
                let rejectReasons = [];

                let durationMin = durationSec / 60;
                if (!isShort && currentConfig.checkLen && (durationMin < currentConfig.minLen || durationMin > currentConfig.maxLen)) {
                    isValid = false;
                    rejectReasons.push(`Dài ${Math.round(durationMin)}m`);
                }
                if (currentConfig.checkViews && views < currentConfig.minView) {
                    isValid = false;
                    rejectReasons.push(`Thiếu View (${viewsStr.trim()})`);
                }
                if (!isShort && currentConfig.checkTime && daysAgo > currentConfig.maxDays) {
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
                        const hRes = await fetch(`http://127.0.0.1:18282/api/check_history?video_id=${videoId}`);

                        // KIỂM TRA PHIÊN QUÉT: Đề phòng reset trong lúc chờ fetch
                        if (myState !== scanState) return;

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
                if (currentConfig.maxCount <= 0) {
                    isValid = false; // Bằng 0 thì mặc định không select
                } else if (isValid && myState.validFoundCount >= currentConfig.maxCount) {
                    isValid = false;
                    rejectReasons.push(`Đã đạt Max (${currentConfig.maxCount})`);
                }

                // --- BƯỚC 3: DỰNG GIAO DIỆN ---
                let thumbnail = item.querySelector('ytd-thumbnail, yt-thumbnail-view-model');
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
                    if (isShort) overlayClass += 'is-shorts-overlay ';

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
                    } else if (meetsRequirements) {
                        hashtag.innerText = '#READY';
                        hashtag.style.backgroundColor = 'rgba(34, 197, 94, 0.9)'; // Màu xanh
                    }
                    if (meetsRequirements || isInHistory) overlay.appendChild(hashtag);

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
                    // const stopEvents = ['click', 'mousedown', 'mouseup', 'pointerdown', 'pointerup', 'touchstart'];

                    // // 1. ĐẶC TRỊ CHO SHORTS (Chặn trực tiếp trên các thẻ <a> để không làm liệt nút bấm)
                    // if (isShort) {
                    //     const links = item.querySelectorAll('a');
                    //     links.forEach(a => {
                    //         stopEvents.forEach(ev => {
                    //             a.addEventListener(ev, (e) => {
                    //                 if (overlay.contains(e.target)) {
                    //                     const isSelect = (e.target === qualitySelect || qualitySelect.contains(e.target));
                    //                     const isCheckbox = (e.target.type === 'checkbox' || e.target.classList.contains('yt-ext-checkbox') || e.target.classList.contains('yt-ext-opacity-toggle'));

                    //                     if (ev === 'click' || ev === 'mousedown') {
                    //                         console.log(`[YT-EXT] [Shorts-Link] ${ev} | Target: ${e.target.className} | Select: ${isSelect} | CB: ${isCheckbox}`);
                    //                     }

                    //                     // Nếu click vào select hoặc checkbox, ta KHÔNG preventDefault ở đây 
                    //                     // để trình duyệt xử lý hành vi mặc định (mở menu / tích chọn).
                    //                     if (isSelect || isCheckbox) {
                    //                         e.stopPropagation();
                    //                         e.stopImmediatePropagation();
                    //                     } else {
                    //                         // Click vào nền hoặc nút khác: Chặn đứng hoàn toàn
                    //                         e.preventDefault();
                    //                         e.stopPropagation();
                    //                         e.stopImmediatePropagation();
                    //                     }
                    //                 }
                    //             }, { capture: true });
                    //         });
                    //     });
                    // }

                    // // 2. CHẶN TRÊN CÁC NÚT ĐIỀU KHIỂN (Xử lý nội bộ cho cả 2 loại)
                    // [qualitySelect, mainCheckbox, dlBtn, opacityToggle].forEach(el => {
                    //     if (!el) return;
                    //     stopEvents.forEach(ev => {
                    //         el.addEventListener(ev, (e) => {
                    //             if (ev === 'click' || ev === 'mousedown') {
                    //                 console.log(`[YT-EXT] [Control] ${ev} | Element: ${el.className}`);
                    //             }

                    //             e.stopPropagation();
                    //             e.stopImmediatePropagation();

                    //             if (ev === 'mousedown' && el === qualitySelect) {
                    //                 if (qualitySelect.dataset.fetched !== "true" && qualitySelect.dataset.loading !== "true") {
                    //                     e.preventDefault();
                    //                     fetchVideoQualitiesFromClient(url, qualitySelect);
                    //                 }
                    //             }
                    //         }, { capture: true });
                    //     });
                    // });

                    // // 3. CHẶN TRÊN NỀN OVERLAY (Lớp bảo vệ cuối)
                    // stopEvents.forEach(ev => {
                    //     overlay.addEventListener(ev, (e) => {
                    //         if (e.target === overlay) {
                    //             e.stopPropagation();
                    //             e.stopImmediatePropagation();
                    //             e.preventDefault();
                    //         }
                    //     }, false); 
                    // });

                    const stopEvents = ['click', 'mousedown', 'mouseup', 'pointerdown', 'pointerup'];

                    // Chặn trên toàn bộ Overlay (vùng trống)
                    stopEvents.forEach(ev => {
                        overlay.addEventListener(ev, (e) => e.stopPropagation());
                    });

                    // Chặn đặc biệt trên các nút điều khiển để đảm bảo 100% không lọt
                    [qualitySelect, mainCheckbox, dlBtn, opacityToggle].forEach(el => {
                        if (!el) return;
                        stopEvents.forEach(ev => {
                            el.addEventListener(ev, (e) => e.stopPropagation());
                        });
                    });

                    // Events
                    qualitySelect.addEventListener('mousedown', (e) => {
                        if (qualitySelect.dataset.fetched !== "true" && qualitySelect.dataset.loading !== "true") {
                            e.preventDefault();
                            fetchVideoQualitiesFromClient(url, qualitySelect);
                        }
                    });

                    qualitySelect.addEventListener('click', (e) => e.stopPropagation());

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
                        console.log(`[YT-EXT] [READY] #${itemIndex} | ${isShort ? '[SHORT]' : '[VIDEO]'} | Views: ${viewsStr.trim()} | Time: ${durationStr} | URL: ${url}`);
                        myState.bulkDownloadItems.set(url, { btn: dlBtn, select: qualitySelect });
                        myState.validFoundCount++;
                    }

                    mainCheckbox.addEventListener('change', () => {
                        const isChecked = mainCheckbox.checked;
                        updateSelectionStatus(isChecked);
                        if (isChecked) {
                            myState.bulkDownloadItems.set(url, { btn: dlBtn, select: qualitySelect });
                        } else {
                            myState.bulkDownloadItems.delete(url);
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
        isScanning = false; // Luôn trả lại khóa để các luồng khác (đang đợi) có thể vào
    }
}

function sendDownloadRequest(url, quality, btnElement) {
    // Không thay đổi trạng thái nút bấm ở đây nữa theo yêu cầu - Giữ nguyên giao diện

    fetch('http://127.0.0.1:18282/api/download', {
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
        scanState.bulkDownloadItems.delete(url);
    }
}

// =========================================================
// CHẾ ĐỘ CHỌN THỦ CÔNG (MANUAL SELECTION MODE)
// =========================================================

let isManualSelectionMode = false;
let manuallySelectedItems = new Map(); // Link element thumbnail => URL video

document.addEventListener('keydown', (e) => {
    if (!window.location.hostname.includes("youtube.com")) return;

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
    if (!window.location.hostname.includes("youtube.com") || !isManualSelectionMode) return;

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

// =========================================================
// WIDGET NỔI ĐỂ DÁN LINK TRỰC TIẾP (DIRECT DOWNLOAD MODE)
// =========================================================

let isDragging = false;
let widgetOffsetX = 0;
let widgetOffsetY = 0;

function initFloatingWidget() {
    if (document.getElementById('yt-ext-floating-widget')) return;

    // Load state từ storage để đồng bộ
    chrome.storage.local.get(['widgetPos', 'widgetText'], (res) => {
        const top = res.widgetPos?.top || '100px';
        const left = res.widgetPos?.left || '20px';
        const text = res.widgetText || '';

        const widgetHTML = `
            <div id="yt-ext-floating-widget" style="top: ${top}; left: ${left};">
                <div class="widget-header">
                    <span class="widget-title">Tải Link Nhanh</span>
                    <button class="widget-close" title="Tắt chế độ này">✕</button>
                </div>
                <div class="widget-body">
                    <textarea id="yt-ext-direct-links" placeholder="Dán các link YouTube vào đây...&#10;Mỗi dòng một link." spellcheck="false">${text}</textarea>
                    <div class="widget-footer">
                        <span id="yt-ext-link-count">0 link</span>
                        <button id="yt-ext-direct-dl-btn">TẢI XUỐNG</button>
                    </div>
                </div>
            </div>
        `;
        document.body.insertAdjacentHTML('beforeend', widgetHTML);

        // Add CSS for widget if not exists yet
        if (!document.getElementById('yt-ext-widget-style')) {
            const style = document.createElement('style');
            style.id = 'yt-ext-widget-style';
            style.textContent = `
                #yt-ext-floating-widget {
                    position: fixed;
                    width: 280px;
                    background: rgba(24, 24, 27, 0.75);
                    backdrop-filter: blur(10px);
                    -webkit-backdrop-filter: blur(10px);
                    border: 1px solid rgba(255,255,255,0.1);
                    border-radius: 12px;
                    z-index: 9999999;
                    box-shadow: 0 10px 25px rgba(0,0,0,0.5);
                    font-family: 'Segoe UI', Tahoma, Verdana, sans-serif;
                    overflow: hidden;
                    transition: opacity 0.2s;
                }
                #yt-ext-floating-widget:not(:hover):not(:focus-within) {
                    opacity: 0.6;
                }
                .widget-header {
                    background: rgba(39, 39, 42, 0.9);
                    padding: 8px 12px;
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    cursor: move;
                    user-select: none;
                    border-bottom: 1px solid rgba(255,255,255,0.05);
                }
                .widget-title { color: #fff; font-size: 13px; font-weight: bold; }
                .widget-close { 
                    background: none; border: none; color: #a1a1aa; cursor: pointer; font-size: 14px; padding: 0;
                }
                .widget-close:hover { color: #f87171; }
                .widget-body { padding: 10px; }
                #yt-ext-direct-links {
                    width: 100%; height: 150px; resize: none; background: rgba(0,0,0,0.4);
                    color: #e4e4e7; border: 1px solid rgba(255,255,255,0.1); border-radius: 6px;
                    padding: 8px; font-size: 11px; box-sizing: border-box; outline: none;
                }
                #yt-ext-direct-links:focus { border-color: #3b82f6; }
                .widget-footer {
                    display: flex; justify-content: space-between; align-items: center; margin-top: 8px;
                }
                #yt-ext-link-count { color: #a1a1aa; font-size: 11px; }
                #yt-ext-direct-dl-btn {
                    background: #22c55e; color: white; border: none; padding: 6px 12px;
                    border-radius: 6px; font-size: 12px; font-weight: bold; cursor: pointer; text-transform: uppercase;
                }
                #yt-ext-direct-dl-btn:hover { background: #16a34a; }
            `;
            document.head.appendChild(style);
        }

        bindWidgetEvents();
        updateLinkCount();
    });
}

function removeFloatingWidget() {
    const el = document.getElementById('yt-ext-floating-widget');
    if (el) el.remove();
}

function bindWidgetEvents() {
    const widget = document.getElementById('yt-ext-floating-widget');
    const header = widget.querySelector('.widget-header');
    const closeBtn = widget.querySelector('.widget-close');
    const textarea = document.getElementById('yt-ext-direct-links');
    const dlBtn = document.getElementById('yt-ext-direct-dl-btn');

    // --- Xử lý Drag & Drop ---
    header.addEventListener('mousedown', (e) => {
        isDragging = true;
        widgetOffsetX = e.clientX - widget.getBoundingClientRect().left;
        widgetOffsetY = e.clientY - widget.getBoundingClientRect().top;
    });

    document.addEventListener('mousemove', (e) => {
        if (!isDragging) return;
        let newX = e.clientX - widgetOffsetX;
        let newY = e.clientY - widgetOffsetY;

        // Không cho phép kéo ra khỏi màn hình
        newX = Math.max(0, Math.min(newX, window.innerWidth - widget.offsetWidth));
        newY = Math.max(0, Math.min(newY, window.innerHeight - widget.offsetHeight));

        widget.style.left = `${newX}px`;
        widget.style.top = `${newY}px`;
    });

    document.addEventListener('mouseup', () => {
        if (isDragging) {
            isDragging = false;
            // Lưu vị trí mới vào storage
            chrome.storage.local.set({
                widgetPos: { top: widget.style.top, left: widget.style.left }
            });
        }
    });

    // --- Cập nhật Storage khi gõ ---
    textarea.addEventListener('input', () => {
        chrome.storage.local.set({ widgetText: textarea.value });
        updateLinkCount();
    });

    // --- Tắt chế độ ---
    closeBtn.addEventListener('click', () => {
        // Cập nhật lên config để tắt
        chrome.storage.local.get(['ytConfig'], (data) => {
            if (data.ytConfig) {
                data.ytConfig.directMode = false;
                chrome.storage.local.set({ ytConfig: data.ytConfig });
            }
        });
        removeFloatingWidget();
        showToast("Đã tắt chế độ Quăng Link Nổi", 2000);
    });

    // --- Bấm tải ---
    dlBtn.addEventListener('click', () => {
        const text = textarea.value;
        const links = extractYTLinks(text);
        if (links.length === 0) {
            showToast("Vui lòng dán link YouTube hợp lệ!", 2000);
            return;
        }

        let q = currentConfig && currentConfig.quality ? currentConfig.quality : '1080';
        let count = 0;

        links.forEach(url => {
            sendDownloadRequest(url, q, null);
            count++;
        });

        // Clear sau khi đẩy đi
        textarea.value = '';
        chrome.storage.local.set({ widgetText: '' });
        updateLinkCount();

        showToast(`🚀 Đã kết nạp ${count} link vào Máy chủ tải!`, 4000);
    });
}

function updateLinkCount() {
    const textarea = document.getElementById('yt-ext-direct-links');
    const span = document.getElementById('yt-ext-link-count');
    if (!textarea || !span) return;

    const count = extractYTLinks(textarea.value).length;
    span.innerText = `${count} link`;
    span.style.color = count > 0 ? '#4ade80' : '#a1a1aa';
}

function extractYTLinks(text) {
    if (!text) return [];
    const tokens = text.split(/[\s\n]+/);
    const validLinks = new Set();
    tokens.forEach(str => {
        const s = str.trim();
        // Bổ sung thêm kiểm tra /shorts/
        if (s.includes('youtube.com') || s.includes('youtube.com/watch') ||
            s.includes('youtu.be/') ||
            s.includes('youtube.com/shorts/')) {
            validLinks.add(s);
        }
    });
    return Array.from(validLinks);
}
