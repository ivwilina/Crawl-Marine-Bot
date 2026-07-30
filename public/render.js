// ============================================================================
//  PUBLIC (BROWSER) · render.js — dựng HTML cho bản đồ tàu, CÓ ESCAPE.
// ----------------------------------------------------------------------------
//  Mọi giá trị đến từ upstream (tên tàu, đích đến, loại tàu...) đều là DỮ LIỆU
//  KHÔNG TIN CẬY. Trước khi nhét vào chuỗi HTML phải qua escapeHtml(); số dùng
//  cho SVG phải qua safeCourse()/safeNumber() -> không thể chèn <script>, không
//  thể chèn style/url(javascript:...).
//
//  File này chạy được ở 2 nơi (một nguồn sự thật duy nhất, không sợ lệch nhau):
//    • trình duyệt -> window.CrawlBotRender
//    • node/test   -> module.exports
// ============================================================================

(function (root) {
  "use strict";

  /** Escape 5 ký tự nguy hiểm trong ngữ cảnh HTML/attribute. */
  function escapeHtml(value) {
    if (value === null || value === undefined) return "";
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  /** Số hữu hạn hoặc null (chuỗi rác -> null). Dùng trước khi ghép vào SVG/CSS. */
  function safeNumber(value) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    return null;
  }

  /** Góc hợp lệ 0–360 hoặc null. Chặn payload kiểu "0);background:url(...)". */
  function safeCourse(value) {
    const n = safeNumber(value);
    if (n === null || n < 0 || n > 360) return null;
    return n;
  }

  /** Giá trị hiển thị đã escape; rỗng -> "—". */
  function fmt(value, unit) {
    if (value === null || value === undefined || value === "") return "—";
    const text = escapeHtml(value);
    return unit ? `${text} ${escapeHtml(unit)}` : text;
  }

  // Category đầy đủ theo kiểu VesselFinder/MarineTraffic — MỌI tàu đều rơi vào
  // đúng 1 category có màu riêng thật, KHÔNG dùng xám cho "chưa rõ loại".
  // color/label do developer định nghĩa (tĩnh) -> an toàn khi nội suy vào HTML.
  const TYPE_COLORS = [
    { match: /tanker|oil|chemical|gas|lng|lpg/i, color: "#ef4444", label: "Tanker" },
    { match: /cargo|container|bulk|general|reefer/i, color: "#f59e0b", label: "Cargo" },
    { match: /passenger|cruise|ferry/i, color: "#a855f7", label: "Passenger" },
    { match: /fishing/i, color: "#ec4899", label: "Fishing" },
    {
      match: /tug|pilot|dredg|offshore|supply|anti.?poll/i,
      color: "#14b8a6",
      label: "Tug / Special craft",
    },
    { match: /pleasure|yacht|sail/i, color: "#22c55e", label: "Pleasure craft" },
    { match: /high.?speed/i, color: "#eab308", label: "High speed craft" },
    { match: /military|law.?enforce|patrol/i, color: "#3b82f6", label: "Military / Law enforcement" },
    { match: /search and rescue|sar/i, color: "#f97316", label: "Search and rescue" },
  ];
  const OTHER_CATEGORY = { color: "#8b5cf6", label: "Other / chưa xác định" };

  function classifyType(type) {
    if (typeof type !== "string" || type === "") return OTHER_CATEGORY;
    return TYPE_COLORS.find((t) => t.match.test(type)) || OTHER_CATEGORY;
  }

  function vesselColor(p) {
    return classifyType(p && p.type).color;
  }

  function isMoving(p) {
    return !!p && typeof p.speedKn === "number" && p.speedKn > 0.5;
  }

  function isAnchored(p) {
    return !!p && typeof p.navStatusText === "string" && /anchor/i.test(p.navStatusText);
  }

  /** Badge tĩnh do developer viết — không chứa giá trị upstream. */
  function statusBadge(p) {
    if (isMoving(p)) return '<span class="badge moving">Đang chạy</span>';
    if (isAnchored(p)) return '<span class="badge anchored">Neo đậu</span>';
    return '<span class="badge stopped">Dừng</span>';
  }

  /** Nhãn hiển thị của 1 tàu (chưa escape — người gọi phải escape). */
  function displayName(p) {
    if (!p) return "Không rõ";
    return p.name || p.imo || p.mmsi || "Không rõ";
  }

  function popupHtml(p) {
    const country = p.country ? ` (${escapeHtml(p.country)})` : "";
    const size = p.lengthM || p.widthM ? `${fmt(p.lengthM)} / ${fmt(p.widthM)} m` : "—";
    const approx = p.latLonApproximate ? " (toạ độ gần đúng)" : "";
    return `
    <div class="popup">
      <h3>${escapeHtml(displayName(p))}</h3>
      <table>
        <tr><td>IMO</td><td class="v">${fmt(p.imo)}</td></tr>
        <tr><td>MMSI</td><td class="v">${fmt(p.mmsi)}</td></tr>
        <tr><td>Loại tàu</td><td class="v">${fmt(p.type)}${country}</td></tr>
        <tr><td>Hiệu hô</td><td class="v">${fmt(p.callsign)}</td></tr>
        <tr><td>Kích thước</td><td class="v">${size}</td></tr>
        <tr><td>Mớn nước</td><td class="v">${fmt(p.draughtM, "m")}</td></tr>
        <tr><td>Tốc độ</td><td class="v">${fmt(p.speedKn, "kn")}</td></tr>
        <tr><td>Hướng</td><td class="v">${fmt(p.courseDeg, "°")}</td></tr>
        <tr><td>Trạng thái</td><td class="v">${fmt(p.navStatusText)}</td></tr>
        <tr><td>Đích đến</td><td class="v">${fmt(p.destination)}</td></tr>
        <tr><td>ETA</td><td class="v">${fmt(p.eta)}</td></tr>
        <tr><td>Vị trí lúc</td><td class="v">${fmt(p.positionTime)}</td></tr>
        <tr><td>Nguồn</td><td class="v">${fmt(p.source)}${approx}</td></tr>
      </table>
    </div>`;
  }

  /** Nội dung 1 dòng trong sidebar (đã escape mọi giá trị upstream). */
  function renderVesselRow(p) {
    const category = classifyType(p && p.type);
    return `
      <div class="name">${escapeHtml(displayName(p))}</div>
      <div class="meta">
        <span style="color:${category.color}">● ${escapeHtml(category.label)}</span>
        <span>${fmt(p && p.speedKn, "kn")}</span>
        ${statusBadge(p)}
      </div>`;
  }

  // 3 dạng icon, phân biệt rõ "biết hướng" vs "không biết hướng":
  //   - Neo đậu (navStatusText xác nhận)  -> chấm tròn viền đậm
  //   - Có course/heading THẬT            -> tam giác xoay đúng hướng
  //   - Đứng yên / chưa rõ hướng          -> chấm tròn viền mỏng
  function shipIconSvg(p) {
    const color = vesselColor(p);
    const course = safeCourse(p && p.courseDeg) ?? safeCourse(p && p.headingDeg);

    if (isAnchored(p)) {
      return {
        html:
          '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 18 18">' +
          `<circle cx="9" cy="9" r="6" fill="${color}" stroke="#0b1420" stroke-width="2"/></svg>`,
        size: [18, 18],
        anchor: [9, 9],
      };
    }

    if (course === null) {
      return {
        html:
          '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 18 18">' +
          `<circle cx="9" cy="9" r="6" fill="${color}" stroke="rgba(11,20,32,.5)" stroke-width="1"/></svg>`,
        size: [18, 18],
        anchor: [9, 9],
      };
    }

    // Tam giác thon dài — mũi nhọn hướng lên, xoay theo course/heading THẬT.
    return {
      html:
        '<svg xmlns="http://www.w3.org/2000/svg" width="22" height="30" viewBox="0 0 22 30" ' +
        `style="transform:rotate(${course}deg)">` +
        '<polygon points="11,0 20,28 2,28" fill="' +
        color +
        '" stroke="#0b1420" stroke-width="1.2" stroke-linejoin="round"/></svg>',
      size: [22, 30],
      anchor: [11, 15],
    };
  }

  /** Legend tĩnh (dữ liệu của developer, không có giá trị upstream). */
  function legendHtml() {
    return TYPE_COLORS.concat([OTHER_CATEGORY])
      .map(
        (i) =>
          `<div class="item"><span class="dot" style="background:${i.color}"></span>${escapeHtml(
            i.label
          )}</div>`
      )
      .join("");
  }

  function keyOf(p) {
    return p.mmsi || p.imo || `${p.lat},${p.lon}`;
  }

  const api = {
    escapeHtml,
    safeNumber,
    safeCourse,
    fmt,
    TYPE_COLORS,
    OTHER_CATEGORY,
    classifyType,
    vesselColor,
    isMoving,
    isAnchored,
    statusBadge,
    displayName,
    popupHtml,
    renderVesselRow,
    shipIconSvg,
    legendHtml,
    keyOf,
  };

  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) root.CrawlBotRender = api;
})(typeof window !== "undefined" ? window : null);
