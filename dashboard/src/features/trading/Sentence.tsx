import type { Seg } from "@/lib/describeMandate";

/** Renders `Seg[]` (plain pieces and bold numbers) as text. Everything is a text node; React escapes it. */
export function Sentence({ segs }: { segs: Seg[] }) {
  return (
    <>
      {segs.map((s, i) =>
        s.bold ? (
          <strong key={i} className="font-semibold text-ink">
            {s.text}
          </strong>
        ) : (
          <span key={i}>{s.text}</span>
        ),
      )}
    </>
  );
}
