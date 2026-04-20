import yt_dlp
import json
search_opts = {'quiet': True, 'no_warnings': True}
url = "https://www.youtube.com/watch?v=745SZWY6baw"
try:
    with yt_dlp.YoutubeDL(search_opts) as ydl:
        # Lấy thông tin video mà không tải về
        info = ydl.extract_info(url, download=False)
        formats = info.get('formats', [])
        
        # Thu thập các chất lượng video duy nhất (height)
        qualities = set()
        for f in formats:
            if f.get('vcodec') != 'none' and f.get('height') is not None:
                qualities.add(f.get('height'))
        
        # Sắp xếp và in ra danh sách chất lượng
        sorted_qualities = sorted(list(qualities))
        print(f"Supported Qualities: {', '.join(map(str, sorted_qualities))}")

        with open('formats.json', 'w') as f:
            f.write(json.dumps(formats, indent=2))
except Exception as e:
    print(e)