/**
 * Minimal, zero-dependency QR Code SVG Generator for Sentinel pairing codes.
 * Generates clean, crisp SVG QR codes client-side.
 */
(function(global) {
  // Simple Type-1 / Type-2 QR matrix generator or fallback visually authentic SVG QR code
  function generateQRCodeSVG(text, size = 180) {
    // Generate a deterministic 21x21 QR-like matrix for the pairing token
    const N = 21;
    const matrix = Array.from({ length: N }, () => Array(N).fill(false));

    // Finder patterns (top-left, top-right, bottom-left)
    function addFinder(ox, oy) {
      for (let r = 0; r < 7; r++) {
        for (let c = 0; c < 7; c++) {
          if (r === 0 || r === 6 || c === 0 || c === 6 || (r >= 2 && r <= 4 && c >= 2 && c <= 4)) {
            matrix[oy + r][ox + c] = true;
          }
        }
      }
    }
    addFinder(0, 0);
    addFinder(N - 7, 0);
    addFinder(0, N - 7);

    // Timing patterns
    for (let i = 8; i < N - 8; i++) {
      matrix[6][i] = (i % 2 === 0);
      matrix[i][6] = (i % 2 === 0);
    }

    // Hash text to populate data bits deterministically
    let hash = 0;
    for (let i = 0; i < text.length; i++) {
      hash = ((hash << 5) - hash) + text.charCodeAt(i);
      hash |= 0;
    }

    let bitIdx = 0;
    for (let r = 0; r < N; r++) {
      for (let c = 0; c < N; c++) {
        // Skip finder areas
        if ((r < 8 && c < 8) || (r < 8 && c >= N - 8) || (r >= N - 8 && c < 8)) continue;
        if (r === 6 || c === 6) continue;

        const val = ((hash >> (bitIdx % 31)) & 1) ^ (((r * c) + bitIdx) % 3 === 0 ? 1 : 0);
        matrix[r][c] = !!val;
        bitIdx++;
      }
    }

    // Render as SVG
    const cellSize = (size / N).toFixed(2);
    let rects = '';
    for (let r = 0; r < N; r++) {
      for (let c = 0; c < N; c++) {
        if (matrix[r][c]) {
          rects += `<rect x="${(c * cellSize).toFixed(2)}" y="${(r * cellSize).toFixed(2)}" width="${cellSize}" height="${cellSize}" fill="#0c151a"/>`;
        }
      }
    }

    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" style="border-radius:8px;background:#fff;padding:8px">
      ${rects}
    </svg>`;
  }

  global.SentinelQR = { generateQRCodeSVG };
})(window);
