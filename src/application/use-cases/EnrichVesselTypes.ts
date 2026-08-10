// ============================================================================
//  APPLICATION · USE CASE: EnrichVesselTypes
//  → Tàu quét được từ mp2 (ScanArea) chỉ có mmsi + tên + toạ độ, KHÔNG có
//  type/flag/kích thước/HƯỚNG ĐI. Use case này chạy nền, lần lượt tra chi
//  tiết từng tàu còn thiếu `type` (qua trang chi tiết VesselFinder theo
//  mmsi/imo) rồi lưu lại lý lịch đầy đủ — để UI vẽ icon đúng màu + đúng
//  hướng theo loại tàu.
// ----------------------------------------------------------------------------
//  ⚠️ mp2 (quét vùng) KHÔNG mang course/speed cho tàu thường (đã kiểm chứng
//  thực nghiệm: 2 byte "flag" không khớp công thức nào với hướng thật) —
//  chỉ trang chi tiết mới có course/speed CHÍNH XÁC (JSON #djson). Vì đã
//  tải trang chi tiết để lấy type, ta lấy LUÔN course/speed từ đó — không
//  tốn thêm request nào. Toạ độ lat/lon vẫn GIỮ NGUYÊN từ mp2 (chính xác
//  hơn toạ độ làm tròn của trang chi tiết miễn phí).
// ----------------------------------------------------------------------------
//  Đây là tra cứu theo từng tàu -> tạo thêm request upstream ngoài area scan.
//  vùng, nên PHẢI giới hạn tốc độ: batch nhỏ mỗi vòng + nghỉ dài giữa các
//  vòng + jitter ngẫu nhiên + hạ nhiệt khi bị chặn (403).
// ----------------------------------------------------------------------------
//  THỨ TỰ do `getVesselsMissingType` quyết định, và nó trả TÀU CÓ IMO TRƯỚC.
//  Vì mỗi tàu tốn một request, hàng đợi vài chục nghìn tàu mất nhiều ngày mới
//  cạn — thứ tự vì thế quyết định app có dữ liệu dùng được sau vài giờ hay phải
//  đợi hết vòng. Có IMO ≈ tàu thương mại, là thứ người dùng thực sự mở ra xem;
//  tàu giải trí/nội địa vẫn được enrich, chỉ là sau.
// ============================================================================

import { IVesselDetailsSource } from "../ports/IVesselDetailsSource";
import { IVesselRepository } from "../ports/IVesselRepository";
import { Vessel } from "../../domain/entities/Vessel";
import { VesselPosition } from "../../domain/entities/VesselPosition";

export interface EnrichVesselTypesDeps {
  detailsSource: IVesselDetailsSource;
  repository: IVesselRepository;
  batchSize?: number; // số tàu tra mỗi vòng (mặc định 15)
  delayMs?: number; // nghỉ giữa 2 tàu trong 1 vòng (mặc định 2s)
  intervalMs?: number; // nghỉ giữa 2 vòng (mặc định 5 phút)
  /** Tiêm được để test không phải chờ thật. */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Mã lỗi nghĩa là "upstream đang từ chối phục vụ", không phải "tàu này có vấn đề".
 *
 * E-2001 là 403/429 nói thẳng. E-2003 là timeout, và nó ở CÙNG nhóm chứ không
 * phải lỗi vặt: khi một site giữ kết nối rồi không trả, đó thường là cách nó
 * siết tốc độ mà không tốn công trả về một trang lỗi. Trước đây chỉ E-2001 được
 * hạ nhiệt, nên đúng lúc bị siết thì worker vẫn nện đều tay.
 */
const UPSTREAM_REFUSAL_CODES = new Set(["E-2001", "E-2003"]);

/** Hạ nhiệt lần đầu. Mỗi lần hỏng liên tiếp tiếp theo thì gấp đôi. */
const COOLDOWN_BASE_MS = 60 * 1000;

/** Trần hạ nhiệt — quá mức này thì chờ thêm cũng không nói lên điều gì mới. */
const COOLDOWN_MAX_MS = 15 * 60 * 1000;

/**
 * Hỏng liên tiếp tới ngần này thì BỎ NỐT VÒNG.
 *
 * Không có ngưỡng này thì một vòng `batchSize` tàu gặp upstream đang từ chối sẽ
 * chạy hết cả batch, mỗi tàu tốn trọn hạn timeout — vừa vô ích vừa là thứ khiến
 * tình hình xấu thêm. Dừng sớm rồi để `intervalMs` nghỉ là phản ứng đúng.
 */
const MAX_CONSECUTIVE_FAILURES = 3;

export class EnrichVesselTypes {
  private readonly detailsSource: IVesselDetailsSource;
  private readonly repository: IVesselRepository;
  private readonly batchSize: number;
  private readonly delayMs: number;
  private readonly intervalMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  /**
   * Chỉ `stop()` bật cờ này. Mặc định false -> `runOnce()` chạy được một mình,
   * giống `ScanArea.scanOnce()`. Trước đây đây là cờ `running` do `start()` bật,
   * nên gọi thẳng `runOnce()` sẽ thoát ngay ở tàu đầu tiên mà không báo gì.
   */
  private stopped = false;

  /**
   * Số lượt hỏng-do-upstream liên tiếp. KHÔNG reset ở đầu mỗi vòng: nếu site
   * đang từ chối thì ranh giới giữa hai vòng chẳng có ý nghĩa gì, và reset ở đó
   * sẽ khiến mức hạ nhiệt không bao giờ leo lên được.
   */
  private consecutiveFailures = 0;

  constructor(deps: EnrichVesselTypesDeps) {
    this.detailsSource = deps.detailsSource;
    this.repository = deps.repository;
    this.batchSize = deps.batchSize ?? 15;
    this.delayMs = deps.delayMs ?? 2000;
    this.intervalMs = deps.intervalMs ?? 5 * 60 * 1000;
    this.sleep = deps.sleep ?? EnrichVesselTypes.sleep;
  }

  /** Chạy 1 vòng: tra tối đa batchSize tàu thiếu type. Trả số tàu đã bổ sung được. */
  async runOnce(): Promise<number> {
    if (this.batchSize <= 0) return 0;
    // Query thẳng tàu thiếu type ở DB (không nạp cả triệu vessel vào RAM).
    const missing = await this.repository.getVesselsMissingType(this.batchSize);
    let done = 0;

    for (const v of missing) {
      if (this.stopped) break;
      // KHÓA = mmsi, KHÔNG bao giờ đổi. Enrich chỉ ĐIỀN thêm IMO/type/kích
      // thước vào cùng bản ghi -> không còn cảnh xóa-tạo-lại gây trùng tàu.
      const mmsi = v.mmsi;

      // Đếm TRƯỚC khi gọi mạng: một lượt timeout không tạo ra Vessel nào để lưu,
      // mà đó đúng là lượt phải được ghi nhận — nếu không, vòng sau lại bốc đúng
      // con tàu này và hàng đợi đứng yên mãi mãi.
      await this.repository.recordEnrichAttempt(mmsi);

      try {
        const details = await this.detailsSource.getDetails(mmsi);

        // Giữ toạ độ chính xác đã có (mp2); chỉ lấy course/speed/trạng thái
        // từ trang chi tiết — dữ liệu mp2 không có.
        const existing = await this.repository.getLatestPosition(mmsi);
        await this.repository.saveVessel(details.vessel);
        await this.repository.savePositionLatest(
          new VesselPosition({
            mmsi,
            imo: details.vessel.imo,
            lat: existing?.lat ?? details.position.lat,
            lon: existing?.lon ?? details.position.lon,
            speedKn: details.position.speedKn,
            courseDeg: details.position.courseDeg,
            navStatusText: details.position.navStatusText,
            destination: details.position.destination,
            eta: details.position.eta,
            // Trang chi tiết là nguồn DUY NHẤT có cảng rời + ATD; quên mang qua
            // là mất chúng, vì bản ghi này ghi đè bản cũ.
            lastPort: details.position.lastPort,
            lastPortDepartureUtc: details.position.lastPortDepartureUtc,
            positionTime: details.position.positionTime,
            source: "vesselfinder",
            latLonApproximate: existing ? existing.latLonApproximate : details.position.latLonApproximate,
          })
        );

        done++;
        this.consecutiveFailures = 0;
        console.log(
          `   🏷️  ${details.vessel.name ?? mmsi} -> ${details.vessel.type ?? "?"}  ${details.position.courseDeg ?? "?"}°`
        );
      } catch (err) {
        const e = err as { code?: string; message: string };
        console.log(`   ⚠️  ${mmsi}  ${e.message}`);

        if (!UPSTREAM_REFUSAL_CODES.has(e.code ?? "")) {
          // Lỗi của riêng tàu này (404, trang không bóc được). Không nói lên
          // điều gì về upstream, nên không hạ nhiệt và không tính vào chuỗi hỏng.
          this.consecutiveFailures = 0;
        } else if (await this.coolDown()) {
          break; // upstream đang từ chối — bỏ nốt vòng
        }
      }
      await this.sleep(EnrichVesselTypes.jitter(this.delayMs));
    }
    return done;
  }

  /**
   * Hạ nhiệt sau một lượt hỏng do upstream, gấp đôi dần theo số lần liên tiếp.
   * @returns `true` khi đã hỏng đủ nhiều để bỏ nốt vòng
   */
  private async coolDown(): Promise<boolean> {
    this.consecutiveFailures += 1;

    const wait = Math.min(
      COOLDOWN_BASE_MS * 2 ** (this.consecutiveFailures - 1),
      COOLDOWN_MAX_MS
    );
    const giveUpRound = this.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES;

    console.log(
      `   🧊 Upstream từ chối (${this.consecutiveFailures} lượt liên tiếp) — nghỉ ${(wait / 1000).toFixed(0)}s` +
        (giveUpRound ? ", rồi bỏ nốt vòng này." : "...")
    );
    await this.sleep(wait);

    return giveUpRound;
  }

  /** Chạy lặp vô hạn (Ctrl+C / stop() để dừng). */
  async start(): Promise<void> {
    this.stopped = false;
    console.log(
      `🏷️  EnrichVesselTypes: mỗi vòng tra tối đa ${this.batchSize} tàu, nghỉ ${this.intervalMs / 60000} phút giữa các vòng.\n`
    );
    while (!this.stopped) {
      try {
        const done = await this.runOnce();
        if (done === 0) {
          console.log("   ✅ Không còn tàu thiếu type (hoặc đang chờ hạ nhiệt).");
        }
      } catch (err) {
        console.log(`   ❌ ${(err as Error).message}`);
      }
      await this.sleep(this.intervalMs);
    }
  }

  stop(): void {
    this.stopped = true;
  }

  private static sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private static jitter(ms: number): number {
    return Math.round(ms * (0.6 + Math.random() * 0.8));
  }
}
