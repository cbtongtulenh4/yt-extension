import os
import sys
import yt_dlp

# Thêm thư mục server vào path để có thể import yt_url
base_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.append(os.path.join(base_dir, 'server'))

from yt_url import get_ffmpeg_path

def test_single_download(url, quality="1080"):
    print(f"[*] Bắt đầu test download URL: {url}")
    print(f"[*] Chất lượng mong muốn: {quality}p")
    
    # 1. Thiết lập thư mục đầu ra
    output_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "downloads_test")
    if not os.path.exists(output_dir):
        os.makedirs(output_dir)
    
    # 2. Lấy đường dẫn FFmpeg (y hệt server)
    ffmpeg_bin_dir = get_ffmpeg_path()
    print(f"[*] FFmpeg Path: {ffmpeg_bin_dir}")
    
    # 3. Chuyển đổi quality sang số
    target_height = int(quality.replace('p', '')) if isinstance(quality, str) else quality
    
    # 4. Cấu hình ydl_opts (Sao chép y hệt từ server/main.py)
    ydl_opts = {
        # bv* = best video, ba = best audio. Ghép lại thành mp4
        'format': f'bv*[height={target_height}]+ba[ext=m4a]/best[ext=mp4]/best',
        'outtmpl': os.path.join(output_dir, '%(title)s [%(height)sp].%(ext)s'),
        'merge_output_format': 'mp4',
        'quiet': False, # Để True nếu muốn ẩn log, False để debug
        'no_warnings': False,
    }
    
    if ffmpeg_bin_dir:
        ydl_opts['ffmpeg_location'] = ffmpeg_bin_dir
        
    try:
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            print("[*] Đang tải...")
            ydl.download([url])
        print(f"\n[+] THÀNH CÔNG! File đã được lưu tại: {output_dir}")
    except Exception as e:
        print(f"\n[!] THẤT BẠI: {str(e)}")

def print_formats(url):
    """
    Hàm liệt kê tất cả các định dạng (Formats) có sẵn của một video.
    Giúp bạn xem được danh sách các link video/audio lẻ mà YouTube cung cấp.
    """
    print(f"\n[*] Đang trích xuất danh sách Formats cho: {url}")
    
    # Lấy đường dẫn FFmpeg để yt-dlp không báo cảnh báo
    ffmpeg_bin_dir = get_ffmpeg_path()
    ydl_opts = {'quiet': True}
    if ffmpeg_bin_dir:
        ydl_opts['ffmpeg_location'] = ffmpeg_bin_dir
    
    try:
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(url, download=False)
            formats = info.get('formats', [])
            
            print(f"{'ID':<10} {'EXT':<6} {'RES':<12} {'FPS':<6} {'VIDEO CODEC':<15} {'AUDIO CODEC'}")
            print("-" * 80)
            
            for f in formats:
                f_id = f.get('format_id', 'N/A')
                ext = f.get('ext', 'N/A')
                res = f.get('resolution', 'audio only')
                fps = str(f.get('fps', ''))
                vcodec = f.get('vcodec', 'none')
                acodec = f.get('acodec', 'none')
                
                print(f"{f_id:<10} {ext:<6} {res:<12} {fps:<6} {vcodec:<15} {acodec}")
                
            print("-" * 80)
            print(f"[+] Tổng cộng: {len(formats)} định dạng.")
            
    except Exception as e:
        print(f"[!] Lỗi khi lấy formats: {str(e)}")

if __name__ == "__main__":
    # Bạn có thể thay đổi URL và chất lượng ở đây để test
    test_url = "https://www.youtube.com/watch?v=dQw4w9WgXcQ" # Video test mặc định
    test_quality = "1080"
    
    test_single_download(test_url, test_quality)
    # print_formats(test_url)
