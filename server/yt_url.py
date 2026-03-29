import os
import sys
import threading
import concurrent.futures
import yt_dlp
from yt_dlp.postprocessor.ffmpeg import FFmpegMergerPP

# =============================================================================
# GLOBAL PATCH: Lock FFmpeg merge to avoid concurrency issues when merging
# =============================================================================
ffmpeg_lock = threading.Lock()
original_merger_run = FFmpegMergerPP.run

def locked_merger_run(self, info):
    with ffmpeg_lock:
        return original_merger_run(self, info)

FFmpegMergerPP.run = locked_merger_run

def get_ffmpeg_path():
    """Locate ffmpeg.exe in several common locations."""
    search_dirs = []
    
    # 1. Directory of the exe or script
    if getattr(sys, 'frozen', False):
        curr_dir = os.path.dirname(sys.executable)
    else:
        curr_dir = os.path.dirname(os.path.abspath(__file__))
    
    search_dirs.append(os.path.join(curr_dir, "bin"))
    search_dirs.append(curr_dir)
    
    # 2. Parent directory's 'bin' (common for development structure)
    parent_dir = os.path.dirname(curr_dir)
    search_dirs.append(os.path.join(parent_dir, "bin"))
    
    # Check all search directories
    for d in search_dirs:
        if os.path.exists(os.path.join(d, "ffmpeg.exe")):
            # print(f"[INFO] Found FFmpeg at: {d}")
            return d
            
    # print("[WARN] FFmpeg (ffmpeg.exe) not found in any common search path!")
    return None

# Global counter for progress tracking
completed_tasks = 0
total_tasks = 0
counter_lock = threading.Lock()

def download_video(url, quality="1080", output_dir="Downloads"):
    """Download a single YouTube video with quality check and progress reporting"""
    # Use output_dir relative to exe if frozen
    if getattr(sys, 'frozen', False):
        base_dir = os.path.dirname(sys.executable)
    else:
        base_dir = os.path.dirname(os.path.abspath(__file__))
        
    final_output_dir = os.path.join(base_dir, output_dir)
    os.makedirs(final_output_dir, exist_ok=True)
    
    global completed_tasks, total_tasks
    
    # Individual progress hook
    def progress_hook(d):
        if d['status'] == 'downloading':
            p = d.get('_percent_str', '0%')
            s = d.get('_speed_str', 'N/A')
            vid = d.get('info_dict', {}).get('id', 'video')
            print(f"[PROGRESS] {vid}: {p} | Speed: {s}", end='\r')
        elif d['status'] == 'finished':
            print(f"\n[FINISH] Downloaded: {url}")
            
    ffmpeg_bin_dir = get_ffmpeg_path()
    search_opts = {'quiet': True, 'no_warnings': True}
    if ffmpeg_bin_dir:
        search_opts['ffmpeg_location'] = ffmpeg_bin_dir
    
    try:
        with yt_dlp.YoutubeDL(search_opts) as ydl:
            info = ydl.extract_info(url, download=False)
            formats = info.get('formats', [])
            available_heights = {f.get('height') for f in formats if f.get('height')}
            target_height = int(quality.replace('p', '')) if isinstance(quality, str) else quality
            best_quality = max(available_heights) if available_heights else 0
            
            # If the best available quality is less than the user requested, skip it.
            # Also skip if the exact quality is missing (depending on strictness, but user said 'below quality').
            if best_quality < target_height:
                with counter_lock:
                    completed_tasks += 1
                    pct = (completed_tasks / total_tasks) * 100
                print(f"[SKIP] {url}: Requested {quality}p but maximum available is only {best_quality}p.")
                print(f"[Overall Progress] {completed_tasks}/{total_tasks} ({pct:.1f}%)")
                return False, url, f"Max quality {best_quality}p < requested {quality}p"
            
            # Extra check: If exactly {target_height} is NOT found in available_heights
            # (Sometimes YT has 360, 720, 2160 but skipping intermediate steps)
            if target_height not in available_heights:
                with counter_lock:
                    completed_tasks += 1
                    pct = (completed_tasks / total_tasks) * 100
                print(f"[SKIP] {url}: Requested EXACT {quality}p not available. (Highest is {best_quality}p, other options: {sorted(list(available_heights))})")
                print(f"[Overall Progress] {completed_tasks}/{total_tasks} ({pct:.1f}%)")
                return False, url, f"Exact quality {quality}p not found"
    except Exception as e:
        with counter_lock:
            completed_tasks += 1
            pct = (completed_tasks / total_tasks) * 100
        print(f"[ERROR] Metadat Extraction Failed: {url} ({str(e)})")
        print(f"[Overall Progress] {completed_tasks}/{total_tasks} ({pct:.1f}%)")
        return False, url, f"Metadata extraction failed: {str(e)}"

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
        print(f"[START] {url} (Quality: {quality}p)")
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            ydl.download([url])
        
        with counter_lock:
            completed_tasks += 1
            pct = (completed_tasks / total_tasks) * 100
            print(f"\n[Overall Progress] {completed_tasks}/{total_tasks} ({pct:.1f}%)")
            
        return True, url, None
    except Exception as e:
        with counter_lock:
            completed_tasks += 1
            pct = (completed_tasks / total_tasks) * 100
        print(f"[ERROR] Failed {url}: {str(e)}")
        print(f"[Overall Progress] {completed_tasks}/{total_tasks} ({pct:.1f}%)")
        return False, url, str(e)

def run_parallel_downloads(url_file, max_threads=3, quality="1080", output_dir="Downloads"):
    """Read URLs from file and download them in parallel"""
    global total_tasks, completed_tasks
    completed_tasks = 0
    
    if not os.path.exists(url_file):
        print(f"Error: File '{url_file}' not found.")
        return

    with open(url_file, "r", encoding="utf-8") as f:
        urls = [line.strip() for line in f if line.strip() and not line.startswith("#")]

    if not urls:
        print("No URLs found in the file.")
        return

    total_tasks = len(urls)
    print(f"Starting parallel download of {total_tasks} videos with {max_threads} threads (Quality: {quality}p)...")
    
    results = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=max_threads) as executor:
        future_to_url = {executor.submit(download_video, url, quality, output_dir): url for url in urls}
        for future in concurrent.futures.as_completed(future_to_url):
            results.append(future.result())

    # Summary
    success_count = sum(1 for r in results if r[0])
    fail_count = len(results) - success_count
    skipped = [r[1] for r in results if r[2] and "Quality" in r[2]]
    
    print("\n" + "="*40)
    print(f"FINAL DOWNLOAD SUMMARY")
    print(f"Total: {total_tasks}")
    print(f"Success: {success_count}")
    print(f"Failed/Skipped: {fail_count}")
    if skipped:
        print(f"Skipped due to quality: {len(skipped)}")
    print("="*40)

if __name__ == "__main__":
    try:
        # Get base directory: use sys.executable if running as .exe
        if getattr(sys, 'frozen', False):
            base_dir = os.path.dirname(sys.executable)
        else:
            base_dir = os.path.dirname(os.path.abspath(__file__))
            
        default_input = os.path.join(base_dir, "input.txt")
        
        # Defaults
        file_path = default_input
        threads = 3
        quality = "1080"

        # Argument handling: python yt_url.py <file> <threads> <quality>
        if len(sys.argv) > 1:
            if sys.argv[1].isdigit(): # Case: python yt_url.py 5 720
                threads = int(sys.argv[1])
                if len(sys.argv) > 2: quality = sys.argv[2]
            else: # Case: python yt_url.py urls.txt 5 720
                file_path = sys.argv[1]
                if len(sys.argv) > 2: threads = int(sys.argv[2])
                if len(sys.argv) > 3: quality = sys.argv[3]
                
            run_parallel_downloads(file_path, threads, quality)
        else:
            # Interactive mode
            if os.path.exists(default_input):
                print(f"Detected input file: {default_input}")
                use_default = "y" # Set to 'y' to skip prompt
                if use_default not in ("", "y", "yes"):
                    file_path = input("Enter path to URL file: ").strip()
            else:
                file_path = input(f"Input file not found. Enter path to URL file: ").strip()
                
            if not file_path: file_path = default_input
                
            qual_input = input("Enter desired quality (360, 480, 720, 1080, 1440, 2160) [default 1080]: ").strip()
            quality = qual_input if qual_input else "1080"
            
            thread_input = input("Enter number of parallel downloads (threads) [default 3]: ").strip()
            threads = int(thread_input) if thread_input.isdigit() else 3
            
            run_parallel_downloads(file_path, threads, quality)
    except Exception as e:
        print(f"[ERROR] {e}")
    finally:
        input("Press Enter to exit...")
    