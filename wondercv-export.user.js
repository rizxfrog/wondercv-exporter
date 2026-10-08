// ==UserScript==
// @name         WonderCV 简历本地导出（无水印·官方样式·数据可携带）
// @namespace    local.wondercv.export
// @version      4.0
// @description  在超级简历编辑器页面，克隆官方预览 DOM（.resume-main）并内联页面全部 wondercv 样式表，剥离 scoped 属性选择器、移除水印背景与编辑控件，新窗口调起打印另存 PDF。渲染用的就是官方自己的 CSS 与 DOM，任何模板样式 100% 一致。数据是你本人的，不碰服务端导出接口，不伪造会员状态。
// @match        https://www.wondercv.com/cvs/*/editor*
// @match        https://www.wondercv.com/cvs/*/preview*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
  "use strict";

  // 渲染用的就是官方自己的 CSS 与 DOM，任何模板样式 100% 一致。
  // 关键点：
  // 1) CSS 从 document.styleSheets 序列化（本机代理可能空化 CDN 响应体，页面上下文读取不受影响）
  // 2) 剥离 [data-v-*] scoped 属性选择器——克隆节点的 scoped 哈希可能与新版 CSS 不匹配
  // 3) 水印是 .one-page-container 上的 editer-preview-watermark.png 背景图，内联覆盖为 none
  // 4) 预览内容是异步挂载的（#cv-container 可能暂时为空），导出前轮询等待
  async function waitForContent(timeoutMs = 8000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const cv = document.getElementById("cv-container");
      const rm = document.querySelector(".resume-main");
      if (rm && cv && cv.children.length > 0) return rm;
      if (Date.now() > deadline) throw new Error("预览未渲染（#cv-container 为空）。请确认编辑器页在前台且预览窗格已加载后重试");
      await wait(300);
    }
  }

  function serializeCss() {
    let css = "";
    for (const ss of document.styleSheets) {
      const href = ss.href || "";
      if (href && !/wondercv|alicdn/.test(href)) continue; // 字体等第三方表保留，其余跳过
      try {
        const rules = ss.cssRules || ss.rules;
        if (!rules) continue;
        let t = "";
        for (const r of rules) t += r.cssText + "\n";
        css += "\n/* " + (href || "inline") + " */\n" + t;
      } catch (e) { /* 跨域表（CORS）跳过 */ }
    }
    // 剥离 Vue scoped 属性选择器：克隆 DOM 上的哈希可能与 CSS 版本不一致
    return css.replace(/\[data-v-[a-f0-9]+\]/g, "");
  }

  function cleanClone(root) {
    // 水印清理分两层：
    // A) 导出页 CSS 覆盖——真实类名是 .one-page-container（可能带版本后缀），
    //    用 [class*=one-page-container] 兜住；文件名 editer-preview-watermark 不可靠依赖。
    // B) 此处再按 computed style 在克隆树上精确内联清除——外部规则再怎么写都被 important 压掉。
    const c = root.cloneNode(true);
    const live = [root, ...root.querySelectorAll("*")];
    const clones = [c, ...c.querySelectorAll("*")];
    for (let i = 0; i < live.length; i++) {
      const bg = getComputedStyle(live[i]).backgroundImage || "";
      // 只清预览水印图；其余背景图（装饰花纹等）保留
      if (/watermark/i.test(bg)) clones[i].style.setProperty("background-image", "none", "important");
    }
    // 预览态残留清理：内联高度是缩放后的预览高度（calc(1003.76px)）、.scale 带
    // transform:scale(0.89)，打印时会造成页高与 A4 错位 → 页尾空白/溢出
    c.style.height = "";
    c.querySelectorAll(".scale").forEach((s) => { s.style.transform = ""; s.style.height = ""; });
    return c;
  }

  async function exportPreview() {
    const root = await waitForContent();
    const clone = cleanClone(root);
    // 导出页 CSS 兜底：按真实容器类名 one-page-container 与任何 watermark 类禁用背景图
    const css = serializeCss() +
      "\n[class*=one-page-container], [class*=watermark] { background-image: none !important; }\n" +
      "@page { size: A4; margin: 0; }\n" +
      "* { -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; }\n" +
      "body { margin: 0; background: #fff; }\n" +
      ".resume-main { transform: none !important; zoom: 1 !important; margin: 0 auto !important; box-shadow: none !important; height: auto !important; }\n" +
      /* 官方 CSS 默认 .resume-main .scale { visibility:hidden }，由页面 JS 打印时改回；
         静态导出文档没有那段 JS，必须强制可见 */
      ".resume-main, .resume-main .scale, .resume-main .scale * { visibility: visible !important; }\n" +
      ".scale { transform: none !important; height: auto !important; }\n" +
      /* 打印分页核心：每个纸张容器精确一页 A4，页间 margin 归零（预览态有 16px 间距，
         打印时该缝隙会把后续页推错位，产生页中/页尾空白） */
      "[class*=one-page-container] { width: 210mm !important; height: 297mm !important; margin: 0 !important; overflow: hidden !important; break-after: page; page-break-after: always; box-sizing: border-box; }\n" +
      "[class*=one-page-container]:last-child { break-after: auto; page-break-after: auto; }\n" +
      ".resume-main { width: 210mm !important; }\n";
    const html = '<!DOCTYPE html><html lang="zh"><head><meta charset="utf-8"><title>简历</title>' +
      "<style>" + css + "</style></head><body>" + clone.outerHTML + "</body></html>";
    const w = window.open("", "_blank");
    if (!w) throw new Error("弹窗被拦截，请允许本站弹出窗口");
    w.document.open(); w.document.write(html); w.document.close();
    setTimeout(() => { try { w.focus(); w.print(); } catch (e) {} }, 1500);
  }
  window.__wcvExport = exportPreview;

  // ---------- UI ----------
  function injectUI() {
    if (document.getElementById("wcv-export-btn")) return;
    const btn = document.createElement("button");
    btn.id = "wcv-export-btn";
    btn.textContent = "⬇ 导出简历 (无水印)";
    Object.assign(btn.style, {
      position: "fixed", right: "18px", bottom: "18px", zIndex: 99999,
      padding: "10px 16px", background: "#10b981", color: "#fff",
      border: "none", borderRadius: "8px", cursor: "pointer",
      boxShadow: "0 2px 10px rgba(0,0,0,.25)", fontSize: "14px",
      fontFamily: "inherit",
    });
    btn.onclick = async () => {
      const original = btn.textContent;
      btn.disabled = true;
      btn.textContent = "克隆预览中…";
      try {
        await exportPreview();
        btn.textContent = "✓ 已打开打印窗口";
        setTimeout(() => (btn.textContent = original), 2500);
      } catch (e) {
        alert("导出失败: " + ((e && e.message) || e));
        btn.textContent = original;
      }
      btn.disabled = false;
    };
    document.body.appendChild(btn);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", injectUI);
  } else {
    injectUI();
  }
})();
