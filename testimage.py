import requests

url = "http://localhost:8000/api/predict"
image_path = r"download (4).jpg"  # <-- change this

import os

if not os.path.exists(image_path):
    print(f"ERROR: File not found: {image_path}")
    print(f"Files in current folder: {[f for f in os.listdir('.') if f.lower().endswith(('.jpg','.jpeg','.png'))]}")
    exit(1)

with open(image_path, "rb") as f:
    response = requests.post(
        url,
        files={"file": (os.path.basename(image_path), f, "image/jpeg")},
        headers={
            "X-User-Email": "test@test.com",
            "X-API-Key": "1kQOQh5SQwNGrgs1aGOLIH1OkXanGkDr"
        }
    )

result = response.json()
print(f"HTTP Status: {response.status_code}")
print(f"Full Response: {result}")

if "label" in result:
    print(f"Label:            {result['label']}")
    print(f"Cheat Probability:{result['cheat_probability']:.2%}")
    print(f"ALERT:            {result['alert']}")
else:
    print(f"ERROR from server: {result.get('detail', result)}")
