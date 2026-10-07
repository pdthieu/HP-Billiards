# Roadmap

Kế hoạch phát triển sau Phase 5 và bản thiết kế lại giao diện (10/2026). Mỗi giai đoạn phát hành được độc lập, có test
và không phá protocol cũ (thêm field, không đổi nghĩa field). Thứ tự dưới đây
ưu tiên việc rẻ mà người chơi thấy ngay, rồi mới tới hạ tầng và tính năng lớn.

Ước lượng: S ≈ 1 ngày, M ≈ 2–4 ngày, L ≈ 1–2 tuần.

Chỉ số theo dõi từ Phase 9 trở đi:

- **Ván/phiên**: số ván kết thúc trên mỗi phòng có đủ 2 người (mục tiêu ≥ 2).
- **Tỉ lệ bỏ giữa ván**: ván bắt đầu nhưng không kết thúc.
- **Thời gian tới cú đánh đầu tiên** của người mới (mục tiêu < 60 giây).

---

## Phase 6 · Cảm giác khi đánh (S–M)

Mục tiêu: bàn không còn "câm". Không đổi server.

1. **Âm thanh** (`web/sounds/`, `web/app.js`): cơ chạm bi (theo lực), bi chạm
   bi (theo tốc độ tương đối), bi chạm băng, bi vào lỗ, tiếng lỗi/thắng.
   - Client suy ra sự kiện từ snapshot: bi biến mất → vào lỗ; đổi hướng đột
     ngột → va chạm. Không cần server gửi event.
   - Nút loa trong header, nhớ trong `localStorage`. Mặc định bật, nhưng chỉ
     phát sau tương tác đầu tiên (giới hạn autoplay của trình duyệt).
2. **Hiệu ứng**: chớp nhẹ ở lỗ khi bi rơi, vòng sáng ở điểm chạm cơ, rung
   `navigator.vibrate` 10–20 ms trên điện thoại khi đánh và khi vào lỗ.
3. **Embed**: mở rộng `web/embed.go` để nhúng `sounds/*`.
4. ~~**Góc nhìn 3D**~~ Đã làm (10/2026): bàn 3D bằng Three.js (`web/view3d.js`),
   mặc định trên máy tính, 2D trên điện thoại; camera tự đứng sau gậy khi
   ngắm, nâng lên theo bi khi đánh, nhìn từ trên khi đặt bi; nút Replay phát
   lại cú vừa rồi chậm 0,5×. Xem CLIENT.md, mục *3D view*.

Xong khi: chơi một ván trên điện thoại có đủ tiếng và rung; tắt tiếng được;
`go test ./web` kiểm tra file âm thanh được nhúng.

## Phase 7 · Lý do chơi ván tiếp (M)

> Đã làm (2026-10-07), khác bản kế hoạch dưới đây ở mấy điểm:
> - race 1–25, đặt khi tạo phòng và đổi được giữa các trận;
> - luật phá: luân phiên hoặc người thắng phá;
> - `match` trong `room_state` và `settled`;
> - bảng lịch sử từng ván;
> - nút Leave, rời giữa trận bị xử thua.
>
> Còn lại: mục 3 (tóm tắt ván).

Mục tiêu: Rematch có ý nghĩa.

1. **Tỉ số trong phòng** (`internal/hub/room.go`, `protocol.go`):
   `room_state` và `settled` thêm `score: [a, b]` và `raceTo` (0 = không
   giới hạn). Room đếm ván thắng, reset khi có người rời hẳn.
2. **Chọn "đua tới N"** khi tạo phòng: `POST /api/rooms` nhận `{"raceTo": 3}`;
   client có bộ chọn 1/3/5/7 trên trang đầu. Đạt N thì `phase` vẫn
   `game_over` nhưng thêm `matchWinner`; Rematch khi đó bắt đầu trận mới với
   tỉ số 0–0.
3. **Tóm tắt ván** trong `settled` cuối: server gửi thêm `summary` gồm số cú,
   số lỗi, bi 8 vào lỗ nào, thời gian ván. Client hiện trong panel game over.
4. **Header** hiện tỉ số cạnh tên.

Xong khi: test hub cho đếm tỉ số qua 3 ván và reset khi rời; e2e thấy tỉ số
đổi sau rematch.

## Phase 8 · Người chơi mới (M)

Mục tiêu: người chưa biết luật đánh được cú đầu trong 1 phút.

1. **Tiếng Việt**: tách toàn bộ chuỗi trong `app.js` ra `web/i18n.js` với
   `vi` và `en`, chọn theo `navigator.language`, có nút đổi trong header.
   Các thông báo từ server (`error.message`) giữ tiếng Anh, client dịch theo
   `error.code`.
2. **Hướng dẫn lần đầu**: overlay 3 bước (đặt bi, ngắm, kéo lực) hiện ở
   lượt đầu tiên của người mới, nhớ đã xem trong `localStorage`. Nút "?" mở
   lại và mở trang luật rút gọn (break lỗi, ball in hand, bi 8 phải chỉ lỗ).
3. **Gợi ý theo ngữ cảnh**: dòng trạng thái đã có; bổ sung mũi tên chỉ vào
   thanh lực khi tới lượt mà chưa đánh sau 5 giây.
4. **Chia sẻ**: nút mời dùng `navigator.share` nếu có, nếu không thì copy;
   thêm mã QR của link phòng (vẽ bằng canvas, không cần thư viện ngoài hoặc
   dùng một thư viện nhỏ nhúng sẵn).

Xong khi: người không biết luật được mời thử và đánh được cú đầu không cần hỏi;
toàn bộ e2e chạy với cả hai ngôn ngữ.

## Phase 9 · Đo lường và vận hành (M)

Mục tiêu: biết người ta chơi thế nào và deploy không mất ván.

1. **Sự kiện** (`internal/metrics`): room_created, room_full, game_started,
   game_finished (kèm số cú, thời gian, có bỏ giữa chừng không), reconnect,
   abandon. Ghi log JSON một dòng mỗi sự kiện; sau này đẩy vào bất cứ đâu.
   Thêm `GET /metrics` dạng Prometheus cho số phòng, kết nối, tick time.
2. **Health**: `GET /healthz`. Tắt server êm: nhận SIGTERM, ngừng nhận
   kết nối mới, gửi `error` `server_restarting` cho client, client tự
   reconnect sau 2 giây (đã có cơ chế).
3. **Giữ ván qua restart**: room ghi state (bi, luật, ghế, token) ra file
   JSON trong thư mục `-data` sau mỗi `settled`/`room_state`; khởi động nạp
   lại. Khi có nhiều instance mới cần Redis, chưa làm.
4. **Chống lạm dụng**: giới hạn tạo phòng theo IP (ví dụ 5/phút), giới hạn
   message mỗi kết nối (30/giây, aim không tính), lọc tên thô tục cơ bản.
   Phòng chưa ai từng vào bị xoá sau 2 phút thay vì 10.
5. **Đóng gói**: Dockerfile đa tầng, `docker compose` có Caddy làm TLS;
   tài liệu deploy trong README.

Xong khi: deploy bản mới giữa ván, hai client tự nối lại và ván tiếp tục; có
dashboard tối thiểu từ `/metrics`.

## Phase 10 · Chơi một mình (L)

Mục tiêu: có việc để làm khi không có bạn online.

1. ~~**Bàn tập**~~ Đã làm (10/2026), khác bản nháp: phòng riêng
   (`"practice": true`), giữ luật 8-ball/9-ball và một người đánh cả hai
   bên; có Undo 20 cú, đặt bi trắng mọi lúc, kéo đặt bi bất kỳ, xếp lại bàn.
2. **Máy đánh**: `internal/bot` chạy trong goroutine của room khi ghế 2 là
   bot. Phiên bản đầu: chọn bi hợp lệ có đường thẳng tới lỗ không bị chắn
   (ray cast có sẵn ở client, chuyển sang Go), ngắm theo ghost ball, lực theo
   khoảng cách, thêm nhiễu góc tuỳ độ khó (dễ 2°, vừa 0.8°, khó 0.3°). Nếu
   không có bi nào vào được thì đánh safety về gần băng xa.
3. Bot tuân thủ cùng protocol (gửi `shoot`, `place_cue`, `choose`) để không
   có đường tắt nào trong room.

Xong khi: thắng được bot dễ, thua bot khó thường xuyên; bot không bao giờ
gây `error` từ server (test chạy 100 ván bot với bot).

## Phase 11 · Xã hội (M)

1. **Người xem**: `join` với `spectate: true`, nhận mọi message nhưng không
   gửi được hành động; `room_state` có `spectators: n`. Giới hạn 10 mỗi phòng.
2. **Emote**: message `emote` với 6 giá trị cố định, hiện bong bóng cạnh tên 3
   giây, giới hạn 1 cái/2 giây. Không chat tự do để khỏi lọc nội dung.
3. **Phòng riêng**: `POST /api/rooms` với `{"private": true}`; không hiện
   trong danh sách, chỉ vào bằng link.
4. **Danh sách phòng** hiện số người xem và tỉ số trận đang diễn ra.

## Phase 12 · Độ sâu gameplay (L)

1. ~~**Lăn tự nhiên**~~ Đã làm (10/2026): bi trượt rồi lăn, follow/draw sinh
   ra từ xoáy ban đầu, băng có ma sát ở mũi và hệ số nảy giảm khi đánh mạnh
   (theo Han 2005 và pooltool). Còn lại: chơi thử để chỉnh
   `CushionRestitutionFast` và `RollingFriction`.
2. **Xoáy đầy đủ hơn**: squirt nhỏ theo xoáy ngang (1–2°), throw lên bi mục
   tiêu; cho người chơi bật/tắt "vật lý nâng cao" theo phòng.
3. **Xem lại cú vừa đánh**: client giữ snapshot của cú gần nhất, nút phát
   lại 1x/0.5x; không cần server.
4. ~~**Đồng hồ cú đánh**~~ Đã làm (10/2026): 30 giây mỗi cú, 40 giây cho cú
   đầu sau cú phá, mỗi người một lần gia hạn về 40 giây mỗi ván; hết giờ là
   lỗi, đối thủ được bi trong tay; server đếm, tạm dừng khi người đó mất
   kết nối. Chỉnh bằng flag `-shot-clock`, `-shot-clock-long` cho cả server.
   Còn lại: cho chọn thời gian khi tạo phòng.

5. ~~**9-ball**~~ Đã làm (10/2026): chọn 8-ball hoặc 9-ball khi tạo phòng,
   đổi được trong lobby và sau ván; luật WPA mục 5 đủ push-out và 3 lỗi
   liên tiếp.

## Để sau

- Tài khoản nhẹ (đăng nhập bằng link email hoặc OAuth), thống kê cá nhân,
  bảng xếp hạng, ghép đối thủ ngẫu nhiên. Chỉ làm khi số liệu Phase 9 cho
  thấy có người quay lại đều.
- 9-ball và 10-ball: `Rules` hiện tách riêng khỏi physics nên thêm luật mới
  là việc vừa, nhưng chỉ đáng khi 8-ball đã có người chơi.
- Nhiều instance server: cần Redis cho state và pub/sub cho room list.

---

## Thứ tự gợi ý và lý do

| Thứ tự | Giai đoạn | Lý do |
|---|---|---|
| 1 | 6 Cảm giác | Rẻ nhất, thấy ngay, không đụng server |
| 2 | 7 Tỉ số | Tăng ván/phiên, đổi protocol nhỏ |
| 3 | 8 Người mới | Cần trước khi mời người ngoài nhóm bạn |
| 4 | 9 Đo lường | Cần trước khi quyết định các giai đoạn sau |
| 5 | 10 Một mình | Lớn nhất, nhưng giải quyết "không có ai online" |
| 6 | 11 Xã hội | Có số liệu rồi mới biết người ta có rủ nhau không |
| 7 | 12 Gameplay sâu | Dành cho người chơi lâu, cần có người chơi lâu trước |

Mỗi giai đoạn bắt đầu bằng một tài liệu ngắn trong `docs/` mô tả thay đổi
protocol (nếu có) và kết thúc bằng cập nhật `PROTOCOL.md`, `CLIENT.md` và
e2e tương ứng.
