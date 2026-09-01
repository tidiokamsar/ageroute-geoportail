import { useState } from "react";
import html2canvas from "html2canvas";
import { jsPDF } from "jspdf";

export function ExportControl({ targetRef }: { targetRef: React.RefObject<HTMLElement> }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  async function capture(): Promise<HTMLCanvasElement | null> {
    if (!targetRef.current) return null;
    setBusy(true);
    try {
      return await html2canvas(targetRef.current, { useCORS: true, logging: false });
    } catch {
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function exportPng() {
    const canvas = await capture();
    if (!canvas) return;
    const a = document.createElement("a");
    a.href = canvas.toDataURL("image/png");
    a.download = `geoportail-bdri-${Date.now()}.png`;
    a.click();
    setOpen(false);
  }

  async function exportPdf() {
    const canvas = await capture();
    if (!canvas) return;
    const pdf = new jsPDF({ orientation: "landscape", unit: "pt", format: [canvas.width, canvas.height] });
    pdf.addImage(canvas.toDataURL("image/png"), "PNG", 0, 0, canvas.width, canvas.height);
    pdf.save(`geoportail-bdri-${Date.now()}.pdf`);
    setOpen(false);
  }

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        className="rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm shadow hover:bg-gray-50"
        disabled={busy}
      >
        {busy ? "Export..." : "Exporter ▾"}
      </button>
      {open && !busy && (
        <div className="absolute right-0 mt-1 w-36 bg-white rounded-lg shadow border border-gray-100 overflow-hidden z-30">
          <button onClick={exportPng} className="block w-full text-left px-3 py-2 text-sm hover:bg-gray-50">
            Image PNG
          </button>
          <button onClick={exportPdf} className="block w-full text-left px-3 py-2 text-sm hover:bg-gray-50">
            Document PDF
          </button>
        </div>
      )}
    </div>
  );
}
