import requests

url = "https://www.youtube.com/watch?v=745SZWY6baw" # Một video 4K/1080p phổ biến
api_url = "http://127.0.0.1:8000/api/qualities"

try:
    response = requests.post(api_url, json={"url": url})
    print(f"Status Code: {response.status_code}")
    if response.status_code == 200:
        data = response.json()
        print(f"Title: {data.get('title')}")
        print(f"Qualities: {data.get('available_qualities')}")
    else:
        print(f"Error: {response.text}")
except Exception as e:
    print(f"Exception: {e}")
