const multer = require('multer');
const path = require('path');
const fs = require('fs');
const uploadUtil = require('../utils/upload');
const menuMediaService = require('../services/menuMedia.service');
const menuQrService = require('../services/menuQr.service');
const outletService = require('../services/outlet.service');
const logger = require('../utils/logger');

// Normalize stored paths — old QR records may lack the 'uploads/' prefix
const ensureUploadsPrefix = (p) => {
  if (!p) return p;
  const n = p.replace(/\\/g, '/');
  return n.startsWith('uploads/') ? n : `uploads/${n}`;
};

const menuMediaController = {
  /**
   * POST /api/v1/menu-media/:outletId/upload
   * form-data: file (image or pdf), optional: title, displayOrder, menuType
   * menuType: 'restaurant' | 'bar' | custom string (default: 'restaurant')
   * Auto-generates QR code on first upload for each menuType
   */
  async uploadMenuMedia(req, res) {
    const outletId = parseInt(req.params.outletId);
    const subfolder = 'menu';
    const middleware = uploadUtil.singleMenuMedia('file', subfolder);

    middleware(req, res, async (err) => {
      try {
        if (err) {
          if (err instanceof multer.MulterError) {
            if (err.code === 'LIMIT_FILE_SIZE') {
              return res.status(400).json({ success: false, message: `File too large. Max: ${(uploadUtil.MAX_FILE_SIZE / (1024*1024)).toFixed(0)}MB` });
            }
            return res.status(400).json({ success: false, message: err.message });
          }
          return res.status(500).json({ success: false, message: err.message });
        }
        if (!req.file) {
          return res.status(400).json({ success: false, message: 'No file provided. Send in "file" field (multipart/form-data).'});
        }

        const { title = null, displayOrder = 0, menuType = 'restaurant' } = req.body || {};
        const fileInfo = uploadUtil.formatFileResponse(req, req.file);
        const isPdf = (fileInfo.extension || '').toLowerCase() === '.pdf' || req.file.mimetype === 'application/pdf';
        const fileType = isPdf ? 'pdf' : 'image';

        // Store only relative path in DB
        const record = await menuMediaService.create(outletId, {
          fileType,
          title,
          path: fileInfo.path,
          displayOrder: parseInt(displayOrder) || 0,
          isActive: 1,
          menuType: menuType || 'restaurant'
        });

        // Auto-generate QR code for this menuType (creates only if not exists)
        const qrRecord = await menuQrService.getOrCreateQr(outletId, menuType || 'restaurant');

        // Prefix APP_URL only in response
        const urlApp = uploadUtil.buildAbsoluteUrlFromApp(fileInfo.path);
          const qrUrl = uploadUtil.buildAbsoluteUrlFromApp(ensureUploadsPrefix(qrRecord.qr_path));
        res.json({ 
          success: true, 
          message: 'Menu media uploaded', 
          data: { 
            record: { ...record, url: urlApp }, 
            file: { ...fileInfo, url: urlApp },
            qr: { ...qrRecord, qrUrl }
          } 
        });
      } catch (error) {
        logger.error('uploadMenuMedia error:', error);
        res.status(500).json({ success: false, message: error.message });
      }
    });
  },

  /**
   * POST /api/v1/menu-media/:outletId/upload/multiple
   * form-data: files[] (image/pdf), optional: titles (JSON array), displayOrders (JSON array), menuType
   * menuType: 'restaurant' | 'bar' | custom string (default: 'restaurant')
   */
  async uploadMultipleMenuMedia(req, res) {
    const outletId = parseInt(req.params.outletId);
    const subfolder = 'menu';
    const middleware = uploadUtil.multipleMenuMedia('files', 20, subfolder);

    middleware(req, res, async (err) => {
      try {
        if (err) {
          if (err instanceof multer.MulterError) {
            if (err.code === 'LIMIT_FILE_SIZE') {
              return res.status(400).json({ success: false, message: `File too large. Max: ${(uploadUtil.MAX_FILE_SIZE / (1024*1024)).toFixed(0)}MB` });
            }
            if (err.code === 'LIMIT_FILE_COUNT') {
              return res.status(400).json({ success: false, message: 'Too many files' });
            }
            return res.status(400).json({ success: false, message: err.message });
          }
          return res.status(500).json({ success: false, message: err.message });
        }
        const files = req.files || [];
        if (files.length === 0) {
          return res.status(400).json({ success: false, message: 'No files provided. Send in "files" field (multipart/form-data).'});
        }

        const menuType = req.body.menuType || 'restaurant';
        let titles = [];
        if (req.body && req.body.titles) {
          try { titles = JSON.parse(req.body.titles); } catch (_) { titles = []; }
        }
        let orders = [];
        if (req.body && req.body.displayOrders) {
          try { orders = JSON.parse(req.body.displayOrders); } catch (_) { orders = []; }
        }

        const created = [];
        for (let idx = 0; idx < files.length; idx++) {
          const f = files[idx];
          const info = uploadUtil.formatFileResponse(req, f);
          const urlApp = uploadUtil.buildAbsoluteUrlFromApp(info.path);
          const isPdf = (info.extension || '').toLowerCase() === '.pdf' || f.mimetype === 'application/pdf';
          const fileType = isPdf ? 'pdf' : 'image';
          const title = Array.isArray(titles) && typeof titles[idx] === 'string' ? titles[idx] : (req.body.title || null);
          const displayOrder = Array.isArray(orders) && Number.isFinite(Number(orders[idx])) ? parseInt(orders[idx]) : (parseInt(req.body.displayOrder) || 0);

          // Store only relative path in DB
          const rec = await menuMediaService.create(outletId, {
            fileType,
            title,
            path: info.path,
            displayOrder,
            isActive: 1,
            menuType
          });
          // Prefix APP_URL only in response
          created.push({ record: { ...rec, url: urlApp }, file: { ...info, url: urlApp } });
        }

        // Auto-generate QR code for this menuType (creates only if not exists)
        const qrRecord = await menuQrService.getOrCreateQr(outletId, menuType);
        const qrUrl = uploadUtil.buildAbsoluteUrlFromApp(ensureUploadsPrefix(qrRecord.qr_path));

        res.json({ success: true, message: `${created.length} file(s) uploaded`, data: created, qr: { ...qrRecord, qrUrl } });
      } catch (error) {
        logger.error('uploadMultipleMenuMedia error:', error);
        res.status(500).json({ success: false, message: error.message });
      }
    });
  },

  /** GET /api/v1/menu-media/:outletId?type=image|pdf|all&isActive=1|0&menuType=restaurant|bar|... */
  async listMenuMedia(req, res) {
    try {
      const outletId = parseInt(req.params.outletId);
      const { type = 'all', isActive = null, menuType = null } = req.query;
      const resolvedActive = isActive === null ? null : (String(isActive) === '1' || String(isActive).toLowerCase() === 'true');
      const rows = await menuMediaService.list(outletId, { type, isActive: resolvedActive, menuType });
      const data = rows.map(r => ({ ...r, url: uploadUtil.buildAbsoluteUrlFromApp(r.path) }));
      res.json({ success: true, data });
    } catch (error) {
      logger.error('listMenuMedia error:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  },

  /** PATCH /api/v1/menu-media/:id/active { isActive } */
  async setActive(req, res) {
    try {
      const id = parseInt(req.params.id);
      const { isActive } = req.body || {};
      const row = await menuMediaService.setActive(id, !!isActive);
      res.json({ success: true, message: 'Status updated', data: row });
    } catch (error) {
      logger.error('setActive error:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  },

  /** PATCH /api/v1/menu-media/:id { title, displayOrder } */
  async updateMeta(req, res) {
    try {
      const id = parseInt(req.params.id);
      const { title = null, displayOrder = 0 } = req.body || {};
      const row = await menuMediaService.updateMeta(id, { title, displayOrder: parseInt(displayOrder) || 0 });
      res.json({ success: true, message: 'Metadata updated', data: row });
    } catch (error) {
      logger.error('updateMeta error:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  },

  /** PATCH /api/v1/menu-media/:id/replace (multipart form-data: file) */
  async replaceMenuMediaFile(req, res) {
    const id = parseInt(req.params.id);
    const middleware = uploadUtil.singleMenuMedia('file', 'menu');
    middleware(req, res, async (err) => {
      try {
        if (err) {
          if (err instanceof multer.MulterError) {
            if (err.code === 'LIMIT_FILE_SIZE') {
              return res.status(400).json({ success: false, message: `File too large. Max: ${(uploadUtil.MAX_FILE_SIZE / (1024*1024)).toFixed(0)}MB` });
            }
            return res.status(400).json({ success: false, message: err.message });
          }
          return res.status(500).json({ success: false, message: err.message });
        }
        const existing = await menuMediaService.getById(id);
        if (!existing) return res.status(404).json({ success: false, message: 'Record not found' });
        if (!req.file) return res.status(400).json({ success: false, message: 'No file provided' });

        const info = uploadUtil.formatFileResponse(req, req.file);
        const urlApp = uploadUtil.buildAbsoluteUrlFromApp(info.path);
        const isPdf = (info.extension || '').toLowerCase() === '.pdf' || req.file.mimetype === 'application/pdf';
        const fileType = isPdf ? 'pdf' : 'image';

        // Store only relative path in DB
        const updated = await menuMediaService.replaceFile(id, { fileType, path: info.path });
        if (existing && existing.path) {
          try { uploadUtil.deleteFile(existing.path); } catch (_) {}
        }
        res.json({ success: true, message: 'File replaced', data: { ...updated, url: urlApp } });
      } catch (error) {
        logger.error('replaceMenuMediaFile error:', error);
        res.status(500).json({ success: false, message: error.message });
      }
    });
  },

  /** DELETE /api/v1/menu-media/:id */
  async deleteMenuMedia(req, res) {
    try {
      const id = parseInt(req.params.id);
      const { row, deleted } = await menuMediaService.delete(id);
      if (!deleted) return res.status(404).json({ success: false, message: 'Record not found' });
      if (row && row.path) {
        try { uploadUtil.deleteFile(row.path); } catch (_) {}
      }
      res.json({ success: true, message: 'Deleted successfully' });
    } catch (error) {
      logger.error('deleteMenuMedia error:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  },

  /** GET /api/v1/menu-media/:outletId/view?type=restaurant|bar|... — Public HTML gallery */
  async renderPublicView(req, res) {
    try {
      const outletId = parseInt(req.params.outletId);
      const menuType = req.query.type || null; // Filter by menu type if provided
      const rows = await menuMediaService.list(outletId, { type: 'all', isActive: true, menuType });
      const outlet = await outletService.getById(outletId);

      // Increment scan count if menuType specified (QR scan)
      if (menuType) {
        menuQrService.incrementScanCount(outletId, menuType).catch(() => {});
      }

      // Normalize URLs to APP_URL + path for reliability
      const items = rows.map(r => ({ ...r, url: uploadUtil.buildAbsoluteUrlFromApp(r.path) }));

      const normalize = (u) => {
        if (!u) return null;
        const s = String(u).trim();
        if (s.startsWith('http://') || s.startsWith('https://')) return s;
        return uploadUtil.buildAbsoluteUrlFromApp(s.replace(/^\/+/, ''));
      };

      const outletName = (outlet && outlet.name) ? outlet.name : `Outlet ${outletId}`;
      const logoUrl = normalize(outlet && (outlet.logo_url || outlet.print_logo_url || outlet.logo || outlet.logoUrl));
      const esc = (s) => String(s || '').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

      const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=5">
  <meta name="theme-color" content="#7f1d1d">
  <meta name="apple-mobile-web-app-capable" content="yes">
  <title>${esc(outletName)} — Menu</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Poppins:wght@300;400;500;600;700&display=swap" rel="stylesheet">
  <style>
    *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
    :root{
      --white:#ffffff;--gray-50:#fafafa;--gray-100:#f4f4f5;--gray-200:#e4e4e7;--gray-300:#d4d4d8;--gray-400:#a1a1aa;--gray-500:#71717a;--gray-600:#52525b;--gray-700:#3f3f46;--gray-800:#27272a;--gray-900:#18181b;
      --maroon-50:#fef2f2;--maroon-100:#fee2e2;--maroon-200:#fecaca;--maroon-500:#991b1b;--maroon-600:#7f1d1d;--maroon-700:#6b1c1c;--maroon-800:#5c1a1a;--maroon-900:#450a0a;
      --gold:#d4a574;--gold-light:#e8c9a8;
      --shadow-sm:0 1px 2px rgba(0,0,0,.04);--shadow:0 4px 12px rgba(0,0,0,.08);--shadow-lg:0 12px 28px rgba(0,0,0,.12);--shadow-xl:0 20px 40px rgba(0,0,0,.15);
      --radius:14px;--radius-lg:20px;--radius-xl:28px;
    }
    html{scroll-behavior:smooth}
    body{font-family:'Poppins',system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:var(--gray-50);color:var(--gray-900);line-height:1.6;min-height:100vh;display:flex;flex-direction:column}

    /* Header */
    .header{background:linear-gradient(135deg,var(--maroon-600) 0%,var(--maroon-800) 50%,var(--maroon-900) 100%);color:var(--white);position:sticky;top:0;z-index:50;box-shadow:var(--shadow-lg)}
    .header::after{content:'';position:absolute;bottom:0;left:0;right:0;height:3px;background:linear-gradient(90deg,var(--gold) 0%,var(--gold-light) 50%,var(--gold) 100%)}
    .header-inner{max-width:1280px;margin:0 auto;padding:18px 24px;display:flex;align-items:center;gap:18px}
    .logo-wrap{flex-shrink:0;width:56px;height:56px;background:var(--white);border-radius:var(--radius);display:flex;align-items:center;justify-content:center;overflow:hidden;box-shadow:var(--shadow);border:2px solid rgba(255,255,255,.15)}
    .logo-wrap img{width:100%;height:100%;object-fit:contain}
    .logo-placeholder{width:56px;height:56px;background:linear-gradient(135deg,var(--gold) 0%,var(--gold-light) 100%);border-radius:var(--radius);display:flex;align-items:center;justify-content:center;font-weight:700;font-size:24px;color:var(--maroon-800);box-shadow:var(--shadow)}
    .brand-info h1{font-size:22px;font-weight:700;letter-spacing:-0.02em;text-shadow:0 1px 3px rgba(0,0,0,.2)}
    .brand-info p{font-size:13px;opacity:.85;margin-top:3px;font-weight:400;display:flex;align-items:center;gap:6px}
    .brand-info p svg{width:15px;height:15px}

    /* Main */
    main{flex:1;max-width:1280px;width:100%;margin:0 auto;padding:28px 24px 48px}
    .section-header{display:flex;align-items:center;justify-content:space-between;margin-bottom:20px}
    .section-title{font-size:13px;font-weight:600;color:var(--maroon-600);text-transform:uppercase;letter-spacing:.1em;display:flex;align-items:center;gap:10px}
    .section-title::before{content:'';width:4px;height:20px;background:linear-gradient(180deg,var(--maroon-500) 0%,var(--maroon-700) 100%);border-radius:2px}
    .section-count{font-size:12px;color:var(--gray-500);background:var(--white);padding:4px 14px;border-radius:20px;box-shadow:var(--shadow-sm);font-weight:500}

    /* Unified Grid */
    .media-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:24px}
    @media(max-width:640px){.media-grid{grid-template-columns:1fr;gap:16px}}

    /* Card (shared for image & pdf) */
    .card{display:block;text-decoration:none;color:inherit;background:var(--white);border-radius:var(--radius-lg);overflow:hidden;box-shadow:var(--shadow);transition:all .3s cubic-bezier(.4,0,.2,1);cursor:pointer;position:relative}
    .card:hover{transform:translateY(-6px);box-shadow:var(--shadow-xl)}
    .card::after{content:'';position:absolute;inset:0;border-radius:var(--radius-lg);border:1px solid rgba(0,0,0,.05);pointer-events:none;z-index:2}
    .card-thumb{position:relative;width:100%;aspect-ratio:4/3;background:var(--gray-100);overflow:hidden}
    .card-thumb img{width:100%;height:100%;object-fit:cover;transition:transform .5s cubic-bezier(.4,0,.2,1)}
    .card:hover .card-thumb img{transform:scale(1.06)}

    /* PDF iframe preview */
    .pdf-thumb-iframe{width:100%;height:100%;border:none;pointer-events:none;background:var(--gray-100)}

    /* Hover overlay */
    .card-overlay{position:absolute;inset:0;background:linear-gradient(180deg,transparent 40%,rgba(0,0,0,.65) 100%);opacity:0;transition:opacity .3s ease;display:flex;align-items:flex-end;justify-content:center;padding:20px;z-index:1}
    .card:hover .card-overlay{opacity:1}
    .card-action{background:var(--white);color:var(--maroon-600);padding:10px 22px;border-radius:30px;font-size:13px;font-weight:600;display:flex;align-items:center;gap:8px;box-shadow:var(--shadow);pointer-events:none}
    .card-action svg{width:18px;height:18px}

    /* Card body */
    .card-body{padding:14px 18px;display:flex;align-items:center;justify-content:space-between}
    .card-title{font-size:14px;font-weight:600;color:var(--gray-800);display:-webkit-box;-webkit-line-clamp:1;-webkit-box-orient:vertical;overflow:hidden;flex:1}
    .card-badge{font-size:10px;font-weight:600;padding:3px 10px;border-radius:12px;text-transform:uppercase;letter-spacing:.04em;flex-shrink:0;margin-left:8px}
    .card-badge.img-badge{background:var(--gray-100);color:var(--gray-600)}
    .card-badge.pdf-badge{background:var(--maroon-100);color:var(--maroon-600)}

    /* Empty */
    .empty-state{text-align:center;padding:80px 24px;background:var(--white);border-radius:var(--radius-xl);box-shadow:var(--shadow)}
    .empty-icon{width:80px;height:80px;margin:0 auto 20px;background:var(--maroon-50);border-radius:50%;display:flex;align-items:center;justify-content:center}
    .empty-icon svg{width:40px;height:40px;color:var(--maroon-500)}
    .empty-state h3{font-size:20px;font-weight:600;color:var(--gray-800);margin-bottom:8px}
    .empty-state p{font-size:15px;color:var(--gray-500);max-width:300px;margin:0 auto}

    /* Footer */
    footer{background:var(--white);border-top:1px solid var(--gray-200);padding:20px;text-align:center}
    footer p{font-size:12px;color:var(--gray-400)}
    footer .brand{color:var(--maroon-600);font-weight:600}

  </style>
</head>
<body>
  <header class="header">
    <div class="header-inner">
      ${logoUrl 
        ? `<div class="logo-wrap"><img src="${logoUrl}" alt="${esc(outletName)}"></div>` 
        : `<div class="logo-placeholder">${esc(outletName.charAt(0).toUpperCase())}</div>`}
      <div class="brand-info">
        <h1>${esc(outletName)}</h1>
        <p><svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M12 6.042A8.967 8.967 0 006 3.75c-1.052 0-2.062.18-3 .512v14.25A8.987 8.987 0 016 18c2.305 0 4.408.867 6 2.292m0-14.25a8.966 8.966 0 016-2.292c1.052 0 2.062.18 3 .512v14.25A8.987 8.987 0 0018 18a8.967 8.967 0 00-6 2.292m0-14.25v14.25"/></svg>Menu</p>
      </div>
    </div>
  </header>

  <main>
    ${items.length === 0 ? `
    <div class="empty-state">
      <div class="empty-icon">
        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M12 6.042A8.967 8.967 0 006 3.75c-1.052 0-2.062.18-3 .512v14.25A8.987 8.987 0 016 18c2.305 0 4.408.867 6 2.292m0-14.25a8.966 8.966 0 016-2.292c1.052 0 2.062.18 3 .512v14.25A8.987 8.987 0 0018 18a8.967 8.967 0 00-6 2.292m0-14.25v14.25"/></svg>
      </div>
      <h3>Menu Coming Soon</h3>
      <p>We're preparing something delicious for you. Check back soon!</p>
    </div>
    ` : `
    <div class="section-header">
      <div class="section-title">Our Menu</div>
      <span class="section-count">${items.length} item${items.length > 1 ? 's' : ''}</span>
    </div>
    <div class="media-grid">
      ${items.map(item => {
        const isPdf = item.file_type === 'pdf';
        const title = esc(item.title) || (isPdf ? 'Menu PDF' : 'Menu Image');
        const safeUrl = esc(item.url);
        return `
      <a class="card" href="${item.url}" target="_blank" rel="noopener noreferrer">
        <div class="card-thumb">
          ${isPdf
            ? `<iframe class="pdf-thumb-iframe" src="${safeUrl}#toolbar=0&navpanes=0&scrollbar=0&view=FitH" title="${title}"></iframe>`
            : `<img src="${safeUrl}" alt="${title}" loading="lazy">`
          }
          <div class="card-overlay">
            <span class="card-action">
              <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M13.5 6H5.25A2.25 2.25 0 003 8.25v10.5A2.25 2.25 0 005.25 21h10.5A2.25 2.25 0 0018 18.75V10.5m-10.5 6L21 3m0 0h-5.25M21 3v5.25"/></svg>
              ${isPdf ? 'Open PDF' : 'Open Image'}
            </span>
          </div>
        </div>
        <div class="card-body">
          <h3 class="card-title">${title}</h3>
          <span class="card-badge ${isPdf ? 'pdf-badge' : 'img-badge'}">${isPdf ? 'PDF' : 'IMG'}</span>
        </div>
      </a>
        `;
      }).join('')}
    </div>
    `}
  </main>

  <footer>
    <p>&copy; ${new Date().getFullYear()} <span class="brand">${esc(outletName)}</span>. All rights reserved.</p>
  </footer>

</body>
</html>`;

      res.set('Content-Type', 'text/html; charset=utf-8');
      res.status(200).send(html);
    } catch (error) {
      logger.error('renderPublicView error:', error);
      res.status(500).send('Failed to render menu');
    }
  },

  // ==================== QR CODE ENDPOINTS ====================

  /** GET /api/v1/menu-media/:outletId/qr — List all QR codes for outlet */
  async listQrCodes(req, res) {
    try {
      const outletId = parseInt(req.params.outletId);
      const qrCodes = await menuQrService.listByOutlet(outletId);
      const data = qrCodes.map(qr => ({
        ...qr,
        qrUrl: uploadUtil.buildAbsoluteUrlFromApp(ensureUploadsPrefix(qr.qr_path)),
        logoUrl: qr.logo_path ? uploadUtil.buildAbsoluteUrlFromApp(ensureUploadsPrefix(qr.logo_path)) : null
      }));
      res.json({ success: true, data });
    } catch (error) {
      logger.error('listQrCodes error:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  },

  /** GET /api/v1/menu-media/:outletId/qr/:menuType — Get specific QR code */
  async getQrCode(req, res) {
    try {
      const outletId = parseInt(req.params.outletId);
      const menuType = req.params.menuType || 'restaurant';
      const qr = await menuQrService.getByOutletAndType(outletId, menuType);
      if (!qr) {
        return res.status(404).json({ success: false, message: `No QR code found for menu type: ${menuType}` });
      }
      res.json({
        success: true,
        data: {
          ...qr,
          qrUrl: uploadUtil.buildAbsoluteUrlFromApp(ensureUploadsPrefix(qr.qr_path)),
          logoUrl: qr.logo_path ? uploadUtil.buildAbsoluteUrlFromApp(ensureUploadsPrefix(qr.logo_path)) : null
        }
      });
    } catch (error) {
      logger.error('getQrCode error:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  },

  /** GET /api/v1/menu-media/:outletId/qr/:menuType/image — Get QR code image directly */
  async getQrImage(req, res) {
    try {
      const outletId = parseInt(req.params.outletId);
      const menuType = req.params.menuType || 'restaurant';
      const qr = await menuQrService.getByOutletAndType(outletId, menuType);
      if (!qr) {
        return res.status(404).json({ success: false, message: `No QR code found for menu type: ${menuType}` });
      }
      const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, '../../uploads');
      const qrRelative = qr.qr_path.replace(/^uploads[\\/]/, '');
      const qrFilePath = path.join(UPLOAD_DIR, qrRelative);
      if (!fs.existsSync(qrFilePath)) {
        return res.status(404).json({ success: false, message: 'QR image file not found' });
      }
      res.set('Content-Type', 'image/png');
      res.sendFile(qrFilePath);
    } catch (error) {
      logger.error('getQrImage error:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  },

  /** POST /api/v1/menu-media/:outletId/qr/:menuType/logo — Upload custom logo for QR */
  async uploadQrLogo(req, res) {
    const outletId = parseInt(req.params.outletId);
    const menuType = req.params.menuType || 'restaurant';
    const subfolder = 'menu-qr/logos';
    const middleware = uploadUtil.singleMenuMedia('logo', subfolder);

    middleware(req, res, async (err) => {
      try {
        if (err) {
          return res.status(400).json({ success: false, message: err.message });
        }
        if (!req.file) {
          return res.status(400).json({ success: false, message: 'No logo file provided. Send in "logo" field.' });
        }

        const fileInfo = uploadUtil.formatFileResponse(req, req.file);
        
        // Update QR with new logo (regenerates QR image with logo overlay)
        const qr = await menuQrService.updateLogo(outletId, menuType, fileInfo.path);
        
        res.json({
          success: true,
          message: 'QR logo updated and QR regenerated',
          data: {
            ...qr,
            qrUrl: uploadUtil.buildAbsoluteUrlFromApp(ensureUploadsPrefix(qr.qr_path)),
            logoUrl: uploadUtil.buildAbsoluteUrlFromApp(ensureUploadsPrefix(qr.logo_path))
          }
        });
      } catch (error) {
        logger.error('uploadQrLogo error:', error);
        res.status(500).json({ success: false, message: error.message });
      }
    });
  },

  /** POST /api/v1/menu-media/:outletId/qr/:menuType/regenerate — Regenerate QR code */
  async regenerateQr(req, res) {
    try {
      const outletId = parseInt(req.params.outletId);
      const menuType = req.params.menuType || 'restaurant';
      const includeLogo = req.body.includeLogo !== false; // Default true
      
      const qr = await menuQrService.regenerateQr(outletId, menuType, includeLogo);
      
      res.json({
        success: true,
        message: 'QR code regenerated',
        data: {
          ...qr,
          qrUrl: uploadUtil.buildAbsoluteUrlFromApp(ensureUploadsPrefix(qr.qr_path)),
          logoUrl: qr.logo_path ? uploadUtil.buildAbsoluteUrlFromApp(ensureUploadsPrefix(qr.logo_path)) : null
        }
      });
    } catch (error) {
      logger.error('regenerateQr error:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  },

  /** GET /api/v1/menu-media/:outletId/menu-types — Get distinct menu types for outlet */
  async getMenuTypes(req, res) {
    try {
      const outletId = parseInt(req.params.outletId);
      const types = await menuMediaService.getMenuTypes(outletId);
      res.json({ success: true, data: types });
    } catch (error) {
      logger.error('getMenuTypes error:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  }
};

module.exports = menuMediaController;
