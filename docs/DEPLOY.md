# Deploy để bạn bè chơi được

Server là một binary Go duy nhất, client đã nhúng sẵn, toàn bộ trạng thái
nằm trong RAM. Cần một máy chạy được container, mở HTTPS (trình duyệt trên
điện thoại chặn WebSocket không mã hoá khi trang mở qua HTTPS, và nút chia
sẻ dùng `navigator.share` cũng đòi HTTPS). Mọi cách dưới đây đều dùng chung
`Dockerfile` ở gốc repo; server tự nghe trên `:$PORT` khi nền tảng đặt biến
`PORT`, và có `GET /healthz` cho health check.

Lưu ý chung: ván đang chơi mất khi server khởi động lại (deploy bản mới,
nền tảng tắt instance). Hai người chơi tự nối lại và vào lại sảnh; việc giữ
ván qua restart nằm trong roadmap Phase 9.

## Chọn nền tảng (tình trạng tháng 10/2026)

| Nền tảng | Miễn phí thật? | Cần thẻ | Ngủ khi vắng | Hợp với game này |
|---|---|---|---|---|
| **Render** (Free web service) | 750 giờ/tháng, 0,1 CPU, 512 MB | Không | Ngủ sau 15 phút không có request hoặc **tin nhắn WebSocket**; thức dậy ~1 phút | **Tốt để bắt đầu**: khi hai người đang chơi, ping 15 s của client giữ server thức. Người đầu tiên mở link sau khi ngủ chờ ~1 phút |
| **Oracle Cloud Always Free** (VM ARM 2 OCPU/12 GB hoặc 2 VM AMD micro) | Máy ảo thật, chạy 24/7 | Có, để xác minh (không trừ tiền) | Không | **Tốt nhất khi chơi thường xuyên**: không ngủ, tự quản HTTPS bằng Caddy. Đăng ký có thể bị từ chối hoặc hết chỗ theo vùng |
| **Google Cloud Run** | 180 000 vCPU-giây, 360 000 GiB-giây, 2 triệu request/tháng | Có | Về 0 instance khi vắng; khởi động 1–2 s | Tốt, nhưng mỗi kết nối WebSocket bị cắt sau 60 phút (client tự nối lại bằng token, chỉ khựng một nhịp) |
| Koyeb | 1 instance 0,1 vCPU/512 MB | Có, giữ tạm 29 USD | Về 0 sau 1 giờ vắng, kết nối WebSocket đang mở giữ nó thức | Được, nhưng thẻ và hold làm nó kém hấp dẫn hơn Render |
| Fly.io | Đã bỏ gói miễn phí (2024) | Có | – | Không còn miễn phí |
| Railway | 5 USD một lần, sau đó 1 USD/tháng | – | – | Không đủ cho một service chạy liên tục |
| Hugging Face Spaces | CPU miễn phí nhưng Docker Space cần gói PRO | – | 48 giờ | Không |

Khuyến nghị: **bắt đầu với Render** (không thẻ, 10 phút), và khi nhóm chơi
đều thì chuyển sang **Oracle Always Free hoặc một VPS 4–5 USD/tháng** bằng
`deploy/docker-compose.yml` (cùng cấu hình cho cả hai).

## Cách 1 · Render, không cần thẻ

1. Đẩy repo lên GitHub (private cũng được).
2. Vào <https://dashboard.render.com>, đăng nhập bằng GitHub, chọn
   **New + → Blueprint**, trỏ vào repo. Render đọc `render.yaml` ở gốc repo:
   runtime Docker, gói Free, vùng Singapore, health check `/healthz`.
   (Hoặc chọn **New + → Web Service**, Runtime *Docker*, Instance type *Free*,
   Health Check Path `/healthz`, Docker Command `/server -max-rooms 10`.)
3. Bấm Deploy. Lần build đầu mất 2–3 phút. Render cấp địa chỉ dạng
   `https://pool-xxxx.onrender.com`, đã có HTTPS.
4. Mở địa chỉ đó, tạo phòng, bấm *Copy link* gửi cho bạn.

Những điều cần biết:

- Server ngủ sau 15 phút không có request và không có tin nhắn WebSocket.
  Trong lúc chơi, client gửi ping mỗi 15 giây nên không ngủ. Người đầu tiên
  mở link sau khi server ngủ sẽ thấy trang xoay khoảng một phút; phòng cũ đã
  mất, cứ tạo phòng mới.
- Free chỉ có 750 giờ/tháng cho cả workspace: một service chạy liên tục là
  vừa đủ, đừng tạo thêm service Free thứ hai.
- Muốn đổi vật lý hay đồng hồ: sửa `dockerCommand` trong `render.yaml`
  (ví dụ `/server -max-rooms 10 -physics RollingFriction=0.01 -shot-clock 45s`)
  rồi push.

### Biến môi trường trên Render

| biến | mặc định | ý nghĩa |
|---|---|---|
| `AIM_LINE_MM` | `100` | độ dài (mm) vạch chỉ hướng bi mục tiêu sau khi chạm, vạch đường đi bi trắng bằng một nửa; `0` là không hiện |
| `PORT` | do Render đặt | đừng tự đặt |

Đặt hoặc đổi: Dashboard → service **pool** → **Environment** → **Add
Environment Variable** (hoặc sửa giá trị) → **Save and deploy** (server
đọc biến lúc khởi động nên không cần build lại; nếu không thấy nút này thì
chọn **Save, rebuild, and deploy**). Không cần push code; phòng đang chơi sẽ
mất vì server khởi động lại. `render.yaml` cố ý không ghi biến này, để giá trị trên
Dashboard không bị Blueprint ghi đè.
- Để không bị cold start có thể nâng lên gói Starter (7 USD/tháng) hoặc dùng
  Cách 2.

## Cách 2 · Máy ảo riêng với Docker Compose và Caddy

Dùng cho Oracle Cloud Always Free, hay bất kỳ VPS nào (Hetzner, DigitalOcean,
Vultr… 4–5 USD/tháng). Caddy tự xin và gia hạn chứng chỉ Let's Encrypt.

### 2a. Tạo máy

Oracle: <https://cloud.oracle.com> → đăng ký (cần thẻ để xác minh, chọn
*Always Free* khi tạo tài nguyên để không bao giờ bị tính tiền) → **Compute →
Instances → Create**. Image *Ubuntu 24.04*, shape *VM.Standard.A1.Flex*
(ARM, Always Free tối đa 2 OCPU/12 GB) hoặc *VM.Standard.E2.1.Micro*. Tải
khoá SSH về. Nếu báo *Out of capacity*, thử vùng khác hoặc thử lại sau vài
giờ; đó là chuyện thường gặp của gói miễn phí.

Mở cổng 80 và 443:

- Trong Oracle: **Networking → Virtual Cloud Networks → (VCN) → Security
  Lists → Default** → *Add Ingress Rules*: Source `0.0.0.0/0`, TCP, Destination
  port `80`; thêm một rule nữa cho `443`, và một rule UDP `443` (HTTP/3, không
  bắt buộc).
- Trong máy (image Ubuntu của Oracle có sẵn iptables chặn):

  ```sh
  sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 80 -j ACCEPT
  sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 443 -j ACCEPT
  sudo iptables -I INPUT 6 -m state --state NEW -p udp --dport 443 -j ACCEPT
  sudo netfilter-persistent save
  ```

### 2b. Tên miền

Caddy cần một tên miền trỏ về IP công khai của máy để lấy chứng chỉ. Hai
cách miễn phí:

- **Không cần đăng ký gì**: dùng sslip.io. IP `140.1.2.3` dùng tên
  `140-1-2-3.sslip.io` (hoặc `140.1.2.3.sslip.io`); tên này tự phân giải về
  đúng IP đó.
- **Tên đẹp hơn**: <https://www.duckdns.org> cho một subdomain
  `tenban.duckdns.org` miễn phí, bạn điền IP của máy vào.

### 2c. Chạy

```sh
# trên máy ảo
sudo apt-get update && sudo apt-get install -y docker.io docker-compose-v2 git
sudo usermod -aG docker $USER && newgrp docker
git clone https://github.com/<bạn>/be-billiards.git && cd be-billiards/deploy
echo "DOMAIN=140-1-2-3.sslip.io" > .env     # tên miền ở bước 2b
docker compose up -d --build
docker compose logs -f caddy                 # chờ dòng "certificate obtained"
```

Mở `https://<DOMAIN>` và chơi. Cập nhật bản mới:

```sh
git pull && docker compose up -d --build
```

Chỉnh vật lý hoặc số phòng: sửa dòng `command:` của service `server` trong
`deploy/docker-compose.yml` rồi chạy lại lệnh trên. Caddy giữ chứng chỉ
trong volume `caddy_data` nên không xin lại mỗi lần khởi động.

## Cách 3 · Google Cloud Run (cần thẻ, trong hạn mức miễn phí)

```sh
gcloud auth login && gcloud config set project <project-id>
gcloud run deploy pool --source . --region asia-southeast1 \
  --allow-unauthenticated --max-instances 1 --timeout 3600 --session-affinity
```

Cloud Run build từ `Dockerfile`, cấp địa chỉ `https://pool-....run.app`.
`--max-instances 1` để mọi người chơi cùng một tiến trình (trạng thái phòng
nằm trong RAM); `--timeout 3600` là mức tối đa, mỗi kết nối WebSocket bị cắt
sau 60 phút và client tự nối lại ngay bằng token ghế. Khi không ai chơi
instance về 0 nên miễn phí; khi có người chơi thì tính theo giây trong hạn
mức 180 000 vCPU-giây/tháng, khoảng 50 giờ chơi liên tục.

## Kiểm tra sau khi deploy

1. `curl https://<địa chỉ>/healthz` trả về `ok`.
2. Mở trang trên điện thoại qua 4G (không cùng Wi-Fi) để chắc là HTTPS và
   WebSocket đi qua được: tạo phòng, gửi link cho một máy khác, bấm sẵn sàng
   ở cả hai, break.
3. Tắt Wi-Fi trên một máy 10 giây rồi bật lại: thẻ "Connection lost" hiện,
   rồi tự vào lại đúng ghế.

## Chạy thử container ở máy mình

```sh
docker build -t pool .
docker run --rm -p 8080:8080 pool -max-rooms 10
# hoặc đúng như trên server: cd deploy && DOMAIN=localhost docker compose up --build
```

Với `DOMAIN=localhost` Caddy tự ký chứng chỉ nội bộ; trình duyệt sẽ cảnh báo,
bấm tiếp tục để thử.
