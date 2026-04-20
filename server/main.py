import os
import sys
import threading
import queue
import concurrent.futures
import yt_dlp
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
import uvicorn
from fastapi.middleware.cors import CORSMiddleware
import random

# Khi import yt_url, cơ chế GLOBAL PATCH: Lock FFmpeg merge sẽ tự động được áp dụng
# do mã global trong yt_url.py tự thực thi.
from yt_url import get_ffmpeg_path 

class ProxyManager:
    def __init__(self, proxy_file="proxies.txt"):
        # Tự động lấy đường dẫn tuyệt đối cùng thư mục với main.py nếu là file name thông thường
        if not os.path.isabs(proxy_file) and "\\" not in proxy_file and "/" not in proxy_file:
            base_path = os.path.dirname(os.path.abspath(__file__))
            proxy_file = os.path.join(base_path, proxy_file)
            
        self.proxy_file = proxy_file
        print(f"[*] ProxyManager using file: {self.proxy_file}")
        self.proxies = []
        self._load_proxies()
        self.lock = threading.Lock()

    def _load_proxies(self):
        if not os.path.exists(self.proxy_file):
            print(f"[!] {self.proxy_file} not found. Running without proxies.")
            self.proxies = []
            self.current_index = 0
            return
        try:
            with open(self.proxy_file, "r") as f:
                lines = [line.strip() for line in f if line.strip()]
            self.proxies = lines
            if self.proxies:
                self.current_index = random.randint(0, len(self.proxies) - 1)
                print(f"[*] Loaded {len(self.proxies)} proxies. Starting at index {self.current_index}")
            else:
                self.current_index = 0
        except Exception as e:
            print(f"[!] Error loading proxies: {e}")
            self.proxies = []
            self.current_index = 0

    def get_proxy(self):
        with self.lock:
            if not self.proxies:
                return None
            raw_proxy = self.proxies[self.current_index]
            self.current_index = (self.current_index + 1) % len(self.proxies)
            
            # Chuyển đổi từ ip:port:user:pass sang http://user:pass@ip:port để yt-dlp hiểu được login
            parts = raw_proxy.split(':')
            if len(parts) == 4:
                return f"http://{parts[2]}:{parts[3]}@{parts[0]}:{parts[1]}"
            return raw_proxy

    def report_dead_proxy(self, proxy):
        with self.lock:
            if proxy in self.proxies:
                print(f"[!] Removing dead proxy: {proxy}")
                self.proxies.remove(proxy)
                if not self.proxies:
                    self.current_index = 0
                else:
                    self.current_index %= len(self.proxies)

proxy_manager = ProxyManager()

app = FastAPI(title="YouTube Downloader Server")

# Allow requests from the extension on any origin (for youtube.com)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Hàng đợi (queue) chứa các link cần tải
download_queue = queue.Queue()

# Dict lưu trạng thái tải trong memory
download_status = {}

class UrlRequest(BaseModel):
    url: str

class DownloadRequest(BaseModel):
    url: str
    quality: str = "1080"
    output_dir: str = "Downloads"

@app.post("/api/qualities")
def get_video_qualities(req: UrlRequest):
    """
    1. Cơ chế nhận link youtube trả về tất cả chất lượng có thể download.
    Sử dụng proxy xoay vòng để tránh bị YouTube block.
    """
    ffmpeg_bin_dir = get_ffmpeg_path()
    
    # Số lần thử tối đa: nếu có proxy thì thử tối đa 10 proxy hoặc số proxy hiện có
    num_proxies = len(proxy_manager.proxies)
    max_retries = max(1, min(10, num_proxies)) if num_proxies > 0 else 1
    
    last_error = "No proxies available or all failed."
    
    for i in range(max_retries):
        proxy = proxy_manager.get_proxy()
        search_opts = {'quiet': True, 'no_warnings': True}
        if ffmpeg_bin_dir:
            search_opts['ffmpeg_location'] = ffmpeg_bin_dir
        
        if proxy:
            search_opts['proxy'] = proxy
            print(f"[*] [Attempt {i+1}/{max_retries}] Fetching info using proxy: {proxy}")
        else:
            print(f"[*] [Attempt {i+1}/{max_retries}] Fetching info without proxy")

        try:
            with yt_dlp.YoutubeDL(search_opts) as ydl:
                # Lấy thông tin video mà không tải về
                info = ydl.extract_info(req.url, download=False)
                formats = info.get('formats', [])
                
                # Lọc ra các chiều cao độ phân giải (ví dụ: 1080, 720, ...)
                available_heights = {f.get('height') for f in formats if f.get('vcodec') not in [None, 'none', 'None'] and f.get('height') is not None}
                
                # Sắp xếp giảm dần để dễ chọn
                sorted_qualities = sorted(list(available_heights), reverse=True)
                
                return {
                    "url": req.url,
                    "title": info.get('title'),
                    "available_qualities": sorted_qualities,
                    "proxy_count": num_proxies,
                    "used_proxy": proxy is not None
                }
        except Exception as e:
            err_msg = str(e).lower()
            print(f"[!] Error on attempt {i+1}: {str(e)}")
            last_error = str(e)
            
            # Kiểm tra nếu lỗi do proxy die hoặc bị block
            if proxy:
                dead_indicators = ["proxy", "connection refused", "timeout", "unable to download webpage", "403", "429"]
                if any(ind in err_msg for ind in dead_indicators):
                    proxy_manager.report_dead_proxy(proxy)
                    # Nếu proxy bị loại, num_proxies giảm, ta vẫn tiếp tục vòng lặp
                
            # Nếu là lỗi do link bị Private hoặc xóa thực sự, không cần thử proxy khác
            # Còn lỗi 'not available' đôi khi là do vùng địa lý (geo-block) 
            # nên vẫn nên thử proxy khác.
            if "private" in err_msg or "deleted" in err_msg:
                break

    raise HTTPException(status_code=400, detail=f"Failed to fetch video information after {max_retries} attempts. Last error: {last_error}")

def process_download(url: str, quality: str = "1080", output_dir: str = "Downloads"):
    """
    Hàm xử lý tải video thực tế.
    Tham khảo logic validation metadata và cấu hình ydl_opts từ yt_url.py
    """
    if getattr(sys, 'frozen', False):
        base_dir = os.path.dirname(sys.executable)
    else:
        base_dir = os.path.dirname(os.path.abspath(__file__))
        
    final_output_dir = os.path.join(base_dir, output_dir)
    os.makedirs(final_output_dir, exist_ok=True)
    
    def progress_hook(d):
        if d['status'] == 'downloading':
            p = d.get('_percent_str', '0%')
            s = d.get('_speed_str', 'N/A')
            # Lưu trạng thái để người dùng có thể query
            download_status[url] = {"status": "downloading", "progress": p, "speed": s}
        elif d['status'] == 'finished':
            download_status[url] = {"status": "processing_merging", "progress": "100%"}
            print(f"\n[FINISH DOWNLOAD - NOW MERGING] {url}")
            
    ffmpeg_bin_dir = get_ffmpeg_path()
    search_opts = {'quiet': True, 'no_warnings': True}
    if ffmpeg_bin_dir:
        search_opts['ffmpeg_location'] = ffmpeg_bin_dir
    
    try:
        # 1. Kiểm tra lại metadata và format (như yt_url.py)
        with yt_dlp.YoutubeDL(search_opts) as ydl:
            info = ydl.extract_info(url, download=False)
            formats = info.get('formats', [])
            available_heights = {f.get('height') for f in formats if f.get('height')}
            target_height = int(quality.replace('p', '')) if isinstance(quality, str) else quality
            best_quality = max(available_heights) if available_heights else 0
            
            if best_quality < target_height:
                msg = f"Max quality {best_quality}p < requested {quality}p"
                print(f"[SKIP] {url}: {msg}")
                download_status[url] = {"status": "error", "message": msg}
                return False
            
            if target_height not in available_heights:
                msg = f"Exact quality {quality}p not found"
                print(f"[SKIP] {url}: {msg}")
                download_status[url] = {"status": "error", "message": msg}
                return False
                
    except Exception as e:
        print(f"[ERROR] Metadat Extraction Failed for {url}: {str(e)}")
        download_status[url] = {"status": "error", "message": str(e)}
        return False

    ydl_opts = {
        'format': f'bv*[height={target_height}]+ba[ext=m4a]/best[ext=mp4]/best',
        'outtmpl': os.path.join(final_output_dir, '%(uploader)s', '%(title)s [%(id)s].%(ext)s'),
        'merge_output_format': 'mp4',
        'quiet': True,
        'no_warnings': True,
        'progress_hooks': [progress_hook],
    }
    
    if ffmpeg_bin_dir:
        ydl_opts['ffmpeg_location'] = ffmpeg_bin_dir
        
    try:
        print(f"[START DOWNLOADING] {url} (Quality: {quality}p)")
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            ydl.download([url])
        
        download_status[url] = {"status": "completed"}
        print(f"[SUCCESS] {url} done!")
        return True
    except Exception as e:
        print(f"[ERROR] Failed {url}: {str(e)}")
        download_status[url] = {"status": "error", "message": str(e)}
        return False

def listener_worker():
    """
    2. Cơ chế luôn lắng nghe: background thread
    Sử dụng ThreadPoolExecutor tương tự run_parallel_downloads bên yt_url.py
    nhưng để phục vụ lấy link từ queue theo thời gian thực.
    """
    max_threads = 3 # Số luồng có thể tùy chỉnh
    print(f"[*] Task Listener Thread Started. Max concurrent workers = {max_threads}")
    
    with concurrent.futures.ThreadPoolExecutor(max_workers=max_threads) as executor:
        while True:
            try:
                # Luôn lắng nghe queue (block cho đến khi có item mới)
                req = download_queue.get(block=True)
                if req is None: 
                    break # Tín hiệu dừng
                
                print(f"[QUEUE Listener] Nhận link mới: {req.url} | Đang đẩy bộ tải đồng thời...")
                download_status[req.url] = {"status": "queued"}
                
                # Submit vào ThreadPoolExecutor để xử lý song song với các link khác
                executor.submit(process_download, req.url, req.quality, req.output_dir)
            except Exception as e:
                print(f"[LISTENER ERROR] {e}")
            finally:
                if 'req' in locals() and req is not None:
                    download_queue.task_done()

# Khởi chạy luồng listener ngay khi app start
threading.Thread(target=listener_worker, daemon=True).start()


@app.post("/api/download")
def add_to_queue(req: DownloadRequest):
    """
    API thêm URL vào hàng đợi (queue), bộ lắng nghe sẽ tự động pick up và tải.
    """
    download_queue.put(req)
    download_status[req.url] = {"status": "added_to_queue"}
    return {
        "message": "Link added to processing queue",
        "url": req.url,
        "queue_size": download_queue.qsize()
    }

@app.get("/api/status")
def get_download_status(url: str):
    """API phụ trợ lấy trạng thái tiến độ hiện tại của URL"""
    return {
        "url": url,
        "status": download_status.get(url, {"status": "not_found"})
    }

if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--port", type=int, default=8000)
    args = parser.parse_args()
    
    uvicorn.run("main:app", host=args.host, port=args.port, reload=True)
