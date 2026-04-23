

import { useState, useEffect, useRef } from "react";

const SYSTEM_PROMPT = `You are a senior researcher at the Institute for Affective Intelligence. A subject has submitted a written review of a place. Analyze the review for emotional intelligence — examining tone, self-awareness, empathy, perspective-taking, and emotional maturity in HOW they write, not just what they describe.

Assign a star rating 1–5 (5 = exemplary EQ, 1 = no discernible EQ).

Respond ONLY with valid JSON, no markdown, no extra text:
{
  "verdict": "EQ" or "NO EQ",
  "stars": 1-5,
  "eq_score": number 0-100,
  "confidence": number 1-100,
  "signals": ["finding 1", "finding 2", "finding 3"],
  "one_line": "one authoritative clinical sentence under 14 words",
  "favor": "a dry academic IOU favor owed to subject, under 12 words, or null if stars is 5"
}

Important: when stars is 5, the favor field must be JSON null (not the string "null").`;

const FAVOR_MESSAGES = [
  "Emotional labor tax applied. Favor logged.",
  "The Institute acknowledges its debt.",
  "Subject compensation pending.",
  "Filed under: We Owe You One.",
  "Institutional debt recorded.",
];

const CREST_SVG = `<svg width="60" height="60" viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg">
  <circle cx="32" cy="32" r="30" stroke="#B8982A" stroke-width="1.5"/>
  <circle cx="32" cy="32" r="24" stroke="#B8982A" stroke-width="0.75"/>
  <polygon points="32,8 36,22 50,22 39,31 43,45 32,36 21,45 25,31 14,22 28,22" fill="none" stroke="#B8982A" stroke-width="1.2"/>
  <text x="32" y="57" text-anchor="middle" font-size="5" fill="#B8982A" font-family="serif" letter-spacing="1">VERITAS · AFFECTUS</text>
</svg>`;

// BUG FIX: bright colors visible on dark background
const scoreColor = (score) => {
  if (score >= 75) return "#3ecf7a";
  if (score >= 50) return "#e8c84a";
  return "#e05555";
};

const getLetterGrade = (score) => {
  if (score >= 90) return "A+";
  if (score >= 85) return "A";
  if (score >= 80) return "A−";
  if (score >= 75) return "B+";
  if (score >= 70) return "B";
  if (score >= 65) return "B−";
  if (score >= 60) return "C+";
  if (score >= 55) return "C";
  if (score >= 50) return "C−";
  if (score >= 40) return "D";
  return "F";
};

// BUG FIX: handle AI returning string "null" for favor
const parseFavor = (favor) => {
  if (!favor || favor === "null" || favor === "undefined") return null;
  return favor;
};

export default function EQAssessment() {
  const [step, setStep] = useState("search");
  const [placeQuery, setPlaceQuery] = useState("");
  const [placeSuggestions, setPlaceSuggestions] = useState([]);
  const [selectedPlace, setSelectedPlace] = useState(null);
  const [review, setReview] = useState("");
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const [searchLoading, setSearchLoading] = useState(false);
  const [error, setError] = useState(null);
  const [favorCount, setFavorCount] = useState(0);
  const [history, setHistory] = useState([]);
  const [newFavor, setNewFavor] = useState(false);
  const [favorMsg, setFavorMsg] = useState("");
  const [showHistory, setShowHistory] = useState(false);
  const debounceRef = useRef(null);

  useEffect(() => {
    const load = async () => {
      try {
        const fc = await window.storage.get("iai-favors");
        if (fc) setFavorCount(parseInt(fc.value) || 0);
        const hist = await window.storage.get("iai-history");
        if (hist) setHistory(JSON.parse(hist.value) || []);
      } catch {}
    };
    load();
  }, []);

  const searchPlaces = async (q) => {
    if (!q || q.length < 3) { setPlaceSuggestions([]); return; }
    setSearchLoading(true);
    try {
      const res = await fetch(
        `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&format=json&limit=6&addressdetails=1`,
        { headers: { "Accept-Language": "en", "User-Agent": "IAI-EQ-Assessment/1.0" } }
      );
      const data = await res.json();
      setPlaceSuggestions(data.slice(0, 6));
    } catch {
      setPlaceSuggestions([]);
    } finally {
      setSearchLoading(false);
    }
  };

  const handlePlaceInput = (val) => {
    setPlaceQuery(val);
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => searchPlaces(val), 400);
  };

  const selectPlace = (place) => {
    const name = place.name || place.display_name.split(",")[0];
    setSelectedPlace({ name, address: place.display_name, type: place.type || place.class });
    setPlaceQuery(name);
    setPlaceSuggestions([]);
    setStep("review");
  };

  const analyze = async () => {
    if (!review.trim() || review.trim().length < 10) return;
    setLoading(true);
    setError(null);
    setResult(null);
    setNewFavor(false);

    try {
      const prompt = selectedPlace
        ? `Place reviewed: ${selectedPlace.name} (${selectedPlace.address})\n\nReview: ${review}`
        : `Review: ${review}`;

      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "claude-sonnet-4-20250514",
          max_tokens: 1000,
          system: SYSTEM_PROMPT,
          messages: [{ role: "user", content: prompt }],
        }),
      });
      const data = await res.json();
      const text = data.content?.map(i => i.text || "").join("") || "";
      const parsed = JSON.parse(text.replace(/```json|```/g, "").trim());
      setResult(parsed);
      setStep("result");

      const newEntry = {
        id: Date.now(),
        place: selectedPlace?.name || "Unspecified Location",
        address: selectedPlace?.address || "",
        verdict: parsed.verdict,
        stars: parsed.stars,
        eq_score: parsed.eq_score,
        one_line: parsed.one_line,
        date: new Date().toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }),
      };

      const newHistory = [newEntry, ...history].slice(0, 20);
      setHistory(newHistory);

      let newCount = favorCount;
      if (parsed.stars < 5) {
        newCount = favorCount + 1;
        setFavorCount(newCount);
        setNewFavor(true);
        setFavorMsg(FAVOR_MESSAGES[Math.floor(Math.random() * FAVOR_MESSAGES.length)]);
      }

      try {
        await window.storage.set("iai-favors", String(newCount));
        await window.storage.set("iai-history", JSON.stringify(newHistory));
      } catch {}
    } catch {
      setError("Assessment could not be completed. Please resubmit.");
    } finally {
      setLoading(false);
    }
  };

  const reset = () => {
    setStep("search");
    setPlaceQuery("");
    setSelectedPlace(null);
    setReview("");
    setResult(null);
    setError(null);
    setNewFavor(false);
    setPlaceSuggestions([]);
  };

  const favor = result ? parseFavor(result.favor) : null;

  return (
    <div style={{
      minHeight: "100vh",
      background: "#0d1b2a",
      backgroundImage: "radial-gradient(ellipse at 20% 50%, rgba(30,50,80,0.4) 0%, transparent 60%), radial-gradient(ellipse at 80% 20%, rgba(20,40,60,0.3) 0%, transparent 50%)",
      display: "flex",
      flexDirection: "column",
      alignItems: "center",
      padding: "32px 12px 60px",
      fontFamily: "'Georgia', 'Times New Roman', serif",
      WebkitFontSmoothing: "antialiased",
    }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=EB+Garamond:ital,wght@0,400;0,500;0,600;0,700;1,400;1,500&family=Cormorant+Garamond:ital,wght@0,400;0,600;0,700;1,400;1,600&family=Inconsolata:wght@400;500&display=swap');

        * { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }

        .iai-wrap { width: 100%; max-width: 680px; }

        .iai-header {
          text-align: center;
          border-bottom: 1px solid #B8982A;
          padding-bottom: 24px;
          margin-bottom: 0;
          position: relative;
        }

        .iai-header::after {
          content: '';
          position: absolute;
          bottom: -4px; left: 50%;
          transform: translateX(-50%);
          width: 55%;
          height: 1px;
          background: rgba(184,152,42,0.25);
        }

        .iai-crest { margin: 0 auto 14px; display: flex; justify-content: center; }

        .iai-institution {
          font-family: 'Inconsolata', monospace;
          font-size: 9px;
          letter-spacing: 0.3em;
          text-transform: uppercase;
          color: #B8982A;
          margin-bottom: 8px;
          opacity: 0.85;
        }

        .iai-title {
          font-family: 'Cormorant Garamond', Georgia, serif;
          font-size: clamp(20px, 5vw, 32px);
          font-weight: 600;
          color: #e8dfc8;
          letter-spacing: 0.03em;
          margin: 0 0 5px;
          line-height: 1.2;
        }

        .iai-subtitle {
          font-family: 'EB Garamond', Georgia, serif;
          font-size: 13px;
          font-style: italic;
          color: rgba(232,223,200,0.45);
        }

        .iai-meta {
          display: flex;
          flex-wrap: wrap;
          justify-content: space-between;
          gap: 6px;
          padding: 13px 0;
          border-bottom: 1px solid rgba(184,152,42,0.18);
          margin-bottom: 28px;
        }

        .iai-meta-item {
          font-family: 'Inconsolata', monospace;
          font-size: 8.5px;
          letter-spacing: 0.15em;
          text-transform: uppercase;
          color: rgba(184,152,42,0.55);
        }

        .iai-meta-val { color: rgba(184,152,42,0.85); font-weight: 500; }

        /* FAVOR TALLY */
        .favor-tally-bar {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 10px 16px;
          background: rgba(139,26,26,0.08);
          border: 1px solid rgba(200,60,60,0.2);
          margin-bottom: 28px;
        }

        .ftb-label {
          font-family: 'Inconsolata', monospace;
          font-size: 9px;
          letter-spacing: 0.18em;
          text-transform: uppercase;
          color: rgba(200,80,80,0.6);
        }

        .ftb-count {
          font-family: 'Cormorant Garamond', serif;
          font-size: 20px;
          font-weight: 700;
          color: rgba(200,80,80,0.8);
        }

        /* PANEL */
        .iai-panel {
          background: rgba(255,255,255,0.03);
          border: 1px solid rgba(184,152,42,0.22);
          padding: 28px 24px;
          position: relative;
          animation: panelIn 0.35s ease;
        }

        @media (min-width: 480px) {
          .iai-panel { padding: 32px 36px; }
        }

        .iai-panel::before {
          content: '';
          position: absolute;
          top: 0; left: 0; right: 0;
          height: 2px;
          background: linear-gradient(90deg, transparent, #B8982A, transparent);
        }

        @keyframes panelIn {
          from { opacity: 0; transform: translateY(8px); }
          to { opacity: 1; transform: translateY(0); }
        }

        .section-label {
          font-family: 'Inconsolata', monospace;
          font-size: 9px;
          letter-spacing: 0.28em;
          text-transform: uppercase;
          color: #B8982A;
          margin-bottom: 8px;
          opacity: 0.8;
        }

        .section-heading {
          font-family: 'Cormorant Garamond', serif;
          font-size: clamp(18px, 4vw, 22px);
          font-weight: 600;
          color: #e8dfc8;
          margin: 0 0 5px;
        }

        .section-desc {
          font-family: 'EB Garamond', serif;
          font-size: 14px;
          font-style: italic;
          color: rgba(232,223,200,0.45);
          margin-bottom: 22px;
          line-height: 1.6;
        }

        .field-label {
          font-family: 'Inconsolata', monospace;
          font-size: 9px;
          letter-spacing: 0.22em;
          text-transform: uppercase;
          color: rgba(184,152,42,0.65);
          margin-bottom: 7px;
          display: block;
        }

        /* SEARCH */
        .place-input-wrap { position: relative; }

        /* BUG FIX: iOS input appearance + no auto-zoom (font-size >= 16px) */
        .iai-input {
          width: 100%;
          background: rgba(255,255,255,0.04);
          border: 1px solid rgba(184,152,42,0.28);
          border-bottom: 1px solid rgba(184,152,42,0.5);
          padding: 13px 40px 13px 16px;
          font-family: 'EB Garamond', serif;
          font-size: 16px;
          color: #e8dfc8;
          outline: none;
          -webkit-appearance: none;
          appearance: none;
          border-radius: 0;
          transition: border-color 0.2s, background 0.2s;
        }

        .iai-input:focus {
          background: rgba(255,255,255,0.07);
          border-color: rgba(184,152,42,0.65);
        }

        .iai-input::placeholder { color: rgba(232,223,200,0.22); font-style: italic; }

        /* BUG FIX: -webkit-overflow-scrolling for smooth iOS scroll */
        .suggestions {
          position: absolute;
          top: 100%; left: 0; right: 0;
          background: #0f2033;
          border: 1px solid rgba(184,152,42,0.35);
          border-top: none;
          z-index: 200;
          max-height: 280px;
          overflow-y: auto;
          -webkit-overflow-scrolling: touch;
        }

        /* BUG FIX: min-height 44px for iOS touch targets */
        .suggestion-item {
          padding: 12px 16px;
          min-height: 52px;
          cursor: pointer;
          border-bottom: 1px solid rgba(184,152,42,0.08);
          transition: background 0.12s;
          display: flex;
          flex-direction: column;
          justify-content: center;
        }

        .suggestion-item:active { background: rgba(184,152,42,0.1); }
        .suggestion-item:last-child { border-bottom: none; }

        .sug-name {
          font-family: 'EB Garamond', serif;
          font-size: 15px;
          color: #e8dfc8;
          margin-bottom: 3px;
        }

        .sug-addr {
          font-family: 'Inconsolata', monospace;
          font-size: 9px;
          color: rgba(184,152,42,0.55);
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }

        .sug-type {
          display: inline-block;
          font-family: 'Inconsolata', monospace;
          font-size: 8px;
          letter-spacing: 0.12em;
          text-transform: uppercase;
          padding: 1px 5px;
          border: 1px solid rgba(184,152,42,0.25);
          color: rgba(184,152,42,0.55);
          margin-right: 5px;
        }

        .iai-divider { border: none; border-top: 1px solid rgba(184,152,42,0.12); margin: 24px 0; }

        .selected-place-badge {
          display: flex;
          align-items: flex-start;
          gap: 10px;
          padding: 12px 14px;
          background: rgba(184,152,42,0.05);
          border: 1px solid rgba(184,152,42,0.18);
          margin-bottom: 20px;
        }

        .spb-icon { font-size: 16px; margin-top: 2px; flex-shrink: 0; opacity: 0.75; }

        .spb-name {
          font-family: 'Cormorant Garamond', serif;
          font-size: 16px;
          font-weight: 600;
          color: #e8dfc8;
          margin-bottom: 2px;
          word-break: break-word;
        }

        .spb-addr {
          font-family: 'Inconsolata', monospace;
          font-size: 8.5px;
          color: rgba(184,152,42,0.55);
          letter-spacing: 0.04em;
          line-height: 1.5;
          word-break: break-word;
        }

        .spb-change {
          margin-left: auto;
          font-family: 'Inconsolata', monospace;
          font-size: 9px;
          letter-spacing: 0.12em;
          text-transform: uppercase;
          color: rgba(184,152,42,0.45);
          cursor: pointer;
          white-space: nowrap;
          padding: 4px 0 4px 8px;
          flex-shrink: 0;
          min-height: 44px;
          display: flex;
          align-items: center;
          transition: color 0.15s;
        }

        .spb-change:active { color: #B8982A; }

        /* BUG FIX: no resize on iOS, font-size >= 16px to prevent zoom */
        .iai-textarea {
          width: 100%;
          min-height: 150px;
          background: rgba(255,255,255,0.04);
          border: 1px solid rgba(184,152,42,0.28);
          padding: 13px 16px;
          font-family: 'EB Garamond', serif;
          font-size: 16px;
          color: #e8dfc8;
          line-height: 1.7;
          resize: none;
          outline: none;
          -webkit-appearance: none;
          appearance: none;
          border-radius: 0;
          transition: border-color 0.2s, background 0.2s;
        }

        .iai-textarea:focus {
          background: rgba(255,255,255,0.07);
          border-color: rgba(184,152,42,0.55);
        }

        .iai-textarea::placeholder { color: rgba(232,223,200,0.18); font-style: italic; }

        .char-count {
          text-align: right;
          font-family: 'Inconsolata', monospace;
          font-size: 9px;
          color: rgba(184,152,42,0.35);
          letter-spacing: 0.08em;
          margin-top: 5px;
        }

        .submit-row { display: flex; align-items: center; gap: 10px; margin-top: 20px; flex-wrap: wrap; }

        /* BUG FIX: min-height 44px for all buttons */
        .iai-btn {
          padding: 0 28px;
          min-height: 48px;
          background: transparent;
          border: 1px solid #B8982A;
          color: #B8982A;
          font-family: 'Cormorant Garamond', serif;
          font-size: 15px;
          font-weight: 600;
          letter-spacing: 0.08em;
          text-transform: uppercase;
          cursor: pointer;
          position: relative;
          overflow: hidden;
          transition: color 0.2s, transform 0.1s;
          -webkit-appearance: none;
          border-radius: 0;
          display: flex;
          align-items: center;
          justify-content: center;
        }

        .iai-btn::before {
          content: '';
          position: absolute;
          inset: 0;
          background: #B8982A;
          transform: scaleX(0);
          transform-origin: left;
          transition: transform 0.2s ease;
          z-index: 0;
        }

        .iai-btn:active::before { transform: scaleX(1); }
        .iai-btn:active { color: #0d1b2a; }
        .iai-btn span { position: relative; z-index: 1; }
        .iai-btn:active { transform: translateY(1px); }
        .iai-btn:disabled { opacity: 0.3; pointer-events: none; }

        .iai-btn-ghost {
          padding: 0 18px;
          min-height: 48px;
          background: transparent;
          border: 1px solid rgba(184,152,42,0.18);
          color: rgba(184,152,42,0.38);
          font-family: 'Inconsolata', monospace;
          font-size: 9px;
          letter-spacing: 0.18em;
          text-transform: uppercase;
          cursor: pointer;
          -webkit-appearance: none;
          border-radius: 0;
          display: flex;
          align-items: center;
          justify-content: center;
          transition: border-color 0.2s, color 0.2s;
        }

        .iai-btn-ghost:active {
          border-color: rgba(184,152,42,0.5);
          color: rgba(184,152,42,0.7);
        }

        /* RESULTS */
        .result-header { display: flex; align-items: flex-start; gap: 18px; margin-bottom: 24px; }

        .verdict-seal {
          flex-shrink: 0;
          width: 80px; height: 80px;
          border-radius: 50%;
          border: 2px solid;
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          gap: 2px;
          animation: sealIn 0.45s ease;
        }

        @keyframes sealIn {
          from { opacity: 0; transform: scale(0.65) rotate(-8deg); }
          to { opacity: 1; transform: scale(1) rotate(0); }
        }

        .verdict-seal-eq { border-color: #1a8a4a; background: rgba(26,138,74,0.07); }
        .verdict-seal-noeq { border-color: #8b1a1a; background: rgba(139,26,26,0.07); }

        .verdict-text {
          font-family: 'Cormorant Garamond', serif;
          font-size: 12px;
          font-weight: 700;
          letter-spacing: 0.08em;
          line-height: 1;
        }

        .verdict-text-eq { color: #3ecf7a; }
        .verdict-text-noeq { color: #e05555; }

        .verdict-grade {
          font-family: 'Cormorant Garamond', serif;
          font-size: 26px;
          font-weight: 700;
          line-height: 1;
        }

        .verdict-grade-eq { color: #3ecf7a; }
        .verdict-grade-noeq { color: #e05555; }

        .result-right { flex: 1; min-width: 0; }

        .result-place {
          font-family: 'Inconsolata', monospace;
          font-size: 9px;
          letter-spacing: 0.18em;
          text-transform: uppercase;
          color: rgba(184,152,42,0.6);
          margin-bottom: 4px;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }

        .result-verdict-line {
          font-family: 'Cormorant Garamond', serif;
          font-size: clamp(17px, 3.5vw, 24px);
          font-weight: 600;
          color: #e8dfc8;
          line-height: 1.25;
          margin-bottom: 6px;
        }

        .result-one-line {
          font-family: 'EB Garamond', serif;
          font-size: 13px;
          color: rgba(232,223,200,0.5);
          font-style: italic;
          line-height: 1.5;
        }

        /* BUG FIX: responsive score grid */
        .score-row {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 10px;
          margin-bottom: 22px;
        }

        .score-box {
          padding: 12px 14px;
          border: 1px solid rgba(184,152,42,0.18);
          background: rgba(255,255,255,0.02);
        }

        .score-box-full { grid-column: span 2; }

        .score-box-label {
          font-family: 'Inconsolata', monospace;
          font-size: 8px;
          letter-spacing: 0.22em;
          text-transform: uppercase;
          color: rgba(184,152,42,0.55);
          margin-bottom: 7px;
        }

        .score-box-val {
          font-family: 'Cormorant Garamond', serif;
          font-size: 26px;
          font-weight: 700;
          line-height: 1;
        }

        .score-box-sub {
          font-family: 'Inconsolata', monospace;
          font-size: 8px;
          color: rgba(232,223,200,0.25);
          letter-spacing: 0.08em;
          margin-top: 3px;
        }

        .star-row { display: flex; gap: 3px; margin-top: 5px; }

        .r-star {
          width: 13px; height: 13px;
          clip-path: polygon(50% 0%, 61% 35%, 98% 35%, 68% 57%, 79% 91%, 50% 70%, 21% 91%, 32% 57%, 2% 35%, 39% 35%);
          transition: background 0.2s;
        }

        .conf-bar-bg {
          height: 4px;
          background: rgba(255,255,255,0.05);
          border: 1px solid rgba(184,152,42,0.1);
          margin-top: 7px;
        }

        .conf-bar-fill { height: 100%; transition: width 1s ease; }

        .findings-section { margin-bottom: 22px; }

        .findings-title {
          font-family: 'Inconsolata', monospace;
          font-size: 9px;
          letter-spacing: 0.28em;
          text-transform: uppercase;
          color: rgba(184,152,42,0.55);
          margin-bottom: 10px;
          padding-bottom: 7px;
          border-bottom: 1px solid rgba(184,152,42,0.12);
        }

        .finding-row { display: flex; gap: 10px; margin-bottom: 9px; align-items: flex-start; }

        .finding-num {
          font-family: 'Inconsolata', monospace;
          font-size: 9px;
          color: rgba(184,152,42,0.35);
          flex-shrink: 0;
          margin-top: 3px;
          width: 18px;
        }

        .finding-text {
          font-family: 'EB Garamond', serif;
          font-size: 15px;
          color: rgba(232,223,200,0.7);
          line-height: 1.6;
        }

        /* IOU */
        .iou-box {
          border: 1px solid rgba(200,60,60,0.35);
          background: rgba(139,26,26,0.06);
          padding: 16px 18px;
          margin-bottom: 18px;
          animation: iouIn 0.45s ease 0.25s both;
        }

        @keyframes iouIn {
          from { opacity: 0; transform: translateX(-5px); }
          to { opacity: 1; transform: translateX(0); }
        }

        .iou-top { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; }

        .iou-label {
          font-family: 'Inconsolata', monospace;
          font-size: 8px;
          letter-spacing: 0.25em;
          text-transform: uppercase;
          color: rgba(200,80,80,0.75);
        }

        .iou-badge {
          font-family: 'Cormorant Garamond', serif;
          font-size: 11px;
          font-weight: 700;
          letter-spacing: 0.12em;
          color: rgba(200,80,80,0.85);
          border: 1px solid rgba(200,80,80,0.35);
          padding: 2px 7px;
        }

        .iou-text {
          font-family: 'EB Garamond', serif;
          font-size: 15px;
          font-style: italic;
          color: rgba(220,160,160,0.8);
          line-height: 1.55;
        }

        .iou-tally {
          font-family: 'Inconsolata', monospace;
          font-size: 8px;
          letter-spacing: 0.12em;
          color: rgba(200,80,80,0.35);
          margin-top: 7px;
          text-transform: uppercase;
        }

        .five-star-box {
          border: 1px solid rgba(26,138,74,0.28);
          background: rgba(26,138,74,0.04);
          padding: 13px 16px;
          margin-bottom: 18px;
          font-family: 'EB Garamond', serif;
          font-size: 14px;
          font-style: italic;
          color: rgba(80,200,130,0.65);
        }

        /* HISTORY */
        .history-toggle {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 15px 0;
          cursor: pointer;
          border-top: 1px solid rgba(184,152,42,0.12);
          margin-top: 28px;
          user-select: none;
          min-height: 44px;
        }

        .history-toggle-label {
          font-family: 'Inconsolata', monospace;
          font-size: 9px;
          letter-spacing: 0.25em;
          text-transform: uppercase;
          color: rgba(184,152,42,0.45);
        }

        .history-toggle-arrow {
          font-size: 9px;
          color: rgba(184,152,42,0.35);
          transition: transform 0.2s;
        }

        .history-list { padding-bottom: 8px; }

        .history-entry {
          display: flex;
          align-items: center;
          gap: 14px;
          padding: 13px 0;
          border-bottom: 1px solid rgba(184,152,42,0.07);
          animation: fadeUp 0.3s ease;
        }

        @keyframes fadeUp {
          from { opacity: 0; transform: translateY(5px); }
          to { opacity: 1; transform: translateY(0); }
        }

        .he-verdict {
          flex-shrink: 0;
          width: 44px; height: 44px;
          border-radius: 50%;
          border: 1px solid;
          display: flex;
          align-items: center;
          justify-content: center;
        }

        .he-eq { border-color: rgba(26,138,74,0.45); }
        .he-noeq { border-color: rgba(139,26,26,0.45); }

        .he-grade { font-family: 'Cormorant Garamond', serif; font-size: 15px; font-weight: 700; line-height: 1; }
        .he-grade-eq { color: #3ecf7a; }
        .he-grade-noeq { color: #e05555; }

        .he-body { flex: 1; min-width: 0; }

        .he-place {
          font-family: 'EB Garamond', serif;
          font-size: 14px;
          color: #e8dfc8;
          margin-bottom: 2px;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }

        .he-meta {
          font-family: 'Inconsolata', monospace;
          font-size: 8.5px;
          color: rgba(184,152,42,0.38);
          letter-spacing: 0.08em;
        }

        .he-score {
          font-family: 'Inconsolata', monospace;
          font-size: 10px;
          color: rgba(184,152,42,0.45);
          flex-shrink: 0;
          letter-spacing: 0.04em;
        }

        .empty-history {
          font-family: 'EB Garamond', serif;
          font-size: 14px;
          font-style: italic;
          color: rgba(232,223,200,0.18);
          text-align: center;
          padding: 18px 0;
        }

        .search-spin {
          position: absolute;
          right: 14px; top: 50%;
          transform: translateY(-50%);
          width: 12px; height: 12px;
          border: 1.5px solid rgba(184,152,42,0.18);
          border-top-color: #B8982A;
          border-radius: 50%;
          animation: spin 0.7s linear infinite;
          pointer-events: none;
        }

        @keyframes spin { to { transform: translateY(-50%) rotate(360deg); } }

        .loading-ring {
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 7px;
          padding: 22px;
        }

        .l-dot {
          width: 6px; height: 6px;
          background: #B8982A;
          border-radius: 50%;
          animation: ldot 1.4s ease-in-out infinite;
        }

        .l-dot:nth-child(2) { animation-delay: 0.2s; }
        .l-dot:nth-child(3) { animation-delay: 0.4s; }

        @keyframes ldot {
          0%, 80%, 100% { opacity: 0.15; transform: scale(0.8); }
          40% { opacity: 1; transform: scale(1.2); }
        }

        .skip-btn {
          width: 100%;
          min-height: 46px;
          margin-top: 16px;
          padding: 0 18px;
          background: transparent;
          border: 1px solid rgba(184,152,42,0.15);
          color: rgba(184,152,42,0.35);
          font-family: 'Inconsolata', monospace;
          font-size: 9px;
          letter-spacing: 0.2em;
          text-transform: uppercase;
          cursor: pointer;
          -webkit-appearance: none;
          border-radius: 0;
          transition: border-color 0.2s, color 0.2s;
          display: flex;
          align-items: center;
          justify-content: center;
        }

        .skip-btn:active {
          border-color: rgba(184,152,42,0.4);
          color: rgba(184,152,42,0.6);
        }

        .footer-line {
          font-family: 'Inconsolata', monospace;
          font-size: 8px;
          letter-spacing: 0.22em;
          text-transform: uppercase;
          color: rgba(184,152,42,0.2);
          text-align: center;
          margin-top: 36px;
        }

        .error-msg {
          font-family: 'Inconsolata', monospace;
          font-size: 9px;
          letter-spacing: 0.15em;
          text-transform: uppercase;
          color: rgba(200,80,80,0.75);
          margin-top: 11px;
          padding: 10px 12px;
          border: 1px solid rgba(200,80,80,0.2);
          background: rgba(139,26,26,0.06);
        }
      `}</style>

      <div className="iai-wrap">

        {/* HEADER */}
        <div className="iai-header">
          <div className="iai-crest" dangerouslySetInnerHTML={{ __html: CREST_SVG }} />
          <div className="iai-institution">Institute for Affective Intelligence · Est. 2024</div>
          <h1 className="iai-title">Affective Intelligence Assessment</h1>
          <div className="iai-subtitle">Standardised Written Review Protocol · Form EQ-7</div>
        </div>

        <div className="iai-meta" style={{ marginTop: 18 }}>
          <div className="iai-meta-item">Type: <span className="iai-meta-val">Written Review Analysis</span></div>
          <div className="iai-meta-item">Method: <span className="iai-meta-val">Linguistic EQ Inference</span></div>
          <div className="iai-meta-item">Version: <span className="iai-meta-val">7.4.2</span></div>
        </div>

        {favorCount > 0 && (
          <div className="favor-tally-bar">
            <div className="ftb-label">Outstanding institutional debt to subject</div>
            <div className="ftb-count">{favorCount} favor{favorCount !== 1 ? "s" : ""}</div>
          </div>
        )}

        {/* STEP 1: SEARCH */}
        {step === "search" && (
          <div className="iai-panel">
            <div className="section-label">Step 1 of 2 · Location Identification</div>
            <h2 className="section-heading">Identify the Subject Location</h2>
            <p className="section-desc">Search for the place you wish to assess. Powered by OpenStreetMap.</p>

            <span className="field-label">Location Search</span>
            <div className="place-input-wrap">
              <input
                className="iai-input"
                placeholder="Restaurant, landmark, business, address…"
                value={placeQuery}
                onChange={e => handlePlaceInput(e.target.value)}
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="off"
                spellCheck={false}
              />
              {searchLoading && <div className="search-spin" />}
              {placeSuggestions.length > 0 && (
                <div className="suggestions">
                  {placeSuggestions.map((p, i) => {
                    const name = p.name || p.display_name.split(",")[0];
                    const type = p.type || p.class || "";
                    return (
                      <div key={i} className="suggestion-item" onClick={() => selectPlace(p)}>
                        <div className="sug-name">
                          {type && <span className="sug-type">{type}</span>}
                          {name}
                        </div>
                        <div className="sug-addr">{p.display_name}</div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            <button className="skip-btn" onClick={() => { setSelectedPlace(null); setStep("review"); }}>
              Skip — Proceed Without Location
            </button>
          </div>
        )}

        {/* STEP 2: REVIEW */}
        {step === "review" && (
          <div className="iai-panel">
            <div className="section-label">Step 2 of 2 · Written Assessment Submission</div>
            <h2 className="section-heading">Submit Your Written Review</h2>
            <p className="section-desc">Write freely. The Institute analyzes the emotional intelligence in your writing, not merely its content.</p>

            {selectedPlace && (
              <div className="selected-place-badge">
                <div className="spb-icon">📍</div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="spb-name">{selectedPlace.name}</div>
                  <div className="spb-addr">{selectedPlace.address}</div>
                </div>
                <div className="spb-change" onClick={() => setStep("search")}>Change</div>
              </div>
            )}

            <span className="field-label">Written Review</span>
            <textarea
              className="iai-textarea"
              placeholder="Describe your experience, impression, or interaction with this place in your own words…"
              value={review}
              onChange={e => setReview(e.target.value)}
              disabled={loading}
            />
            <div className="char-count">{review.length} characters</div>

            {error && <div className="error-msg">{error}</div>}

            {loading ? (
              <div className="loading-ring">
                <div className="l-dot" /><div className="l-dot" /><div className="l-dot" />
                <span style={{ fontFamily: "'Inconsolata', monospace", fontSize: 8.5, letterSpacing: "0.2em", color: "rgba(184,152,42,0.45)", textTransform: "uppercase", marginLeft: 6 }}>
                  Analyzing submission…
                </span>
              </div>
            ) : (
              <div className="submit-row">
                <button className="iai-btn" onClick={analyze} disabled={review.trim().length < 10}>
                  <span>Submit for Assessment</span>
                </button>
                <button className="iai-btn-ghost" onClick={reset}>
                  Start Over
                </button>
              </div>
            )}
          </div>
        )}

        {/* RESULTS */}
        {step === "result" && result && (
          <div className="iai-panel">
            <div className="section-label">Assessment Complete · Form EQ-7</div>

            <div className="result-header">
              <div className={`verdict-seal ${result.verdict === "EQ" ? "verdict-seal-eq" : "verdict-seal-noeq"}`}>
                <div className={`verdict-text ${result.verdict === "EQ" ? "verdict-text-eq" : "verdict-text-noeq"}`}>
                  {result.verdict === "EQ" ? "EQ" : "NO EQ"}
                </div>
                <div className={`verdict-grade ${result.verdict === "EQ" ? "verdict-grade-eq" : "verdict-grade-noeq"}`}>
                  {getLetterGrade(result.eq_score)}
                </div>
              </div>
              <div className="result-right">
                {selectedPlace && <div className="result-place">{selectedPlace.name}</div>}
                <div className="result-verdict-line">
                  {result.verdict === "EQ" ? "Emotional intelligence detected." : "Emotional intelligence not detected."}
                </div>
                <div className="result-one-line">"{result.one_line}"</div>
              </div>
            </div>

            <div className="score-row">
              <div className="score-box">
                <div className="score-box-label">EQ Score</div>
                <div className="score-box-val" style={{ color: scoreColor(result.eq_score) }}>
                  {result.eq_score}<span style={{ fontSize: 13, opacity: 0.45 }}>/100</span>
                </div>
                <div className="score-box-sub">Percentile pending</div>
              </div>
              <div className="score-box">
                <div className="score-box-label">Star Rating</div>
                <div className="star-row">
                  {[1,2,3,4,5].map(i => (
                    <div key={i} className="r-star" style={{
                      background: i <= result.stars
                        ? (result.verdict === "EQ" ? "#3ecf7a" : "#e05555")
                        : "rgba(255,255,255,0.08)"
                    }} />
                  ))}
                </div>
                <div className="score-box-sub">{result.stars} of 5 stars</div>
              </div>
              <div className="score-box score-box-full">
                <div className="score-box-label">Analyst Confidence</div>
                <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 3 }}>
                  <div className="conf-bar-bg" style={{ flex: 1 }}>
                    <div className="conf-bar-fill" style={{
                      width: `${result.confidence}%`,
                      background: result.verdict === "EQ" ? "#3ecf7a" : "#e05555"
                    }} />
                  </div>
                  <span style={{ fontFamily: "'Inconsolata', monospace", fontSize: 11, color: "#e8dfc8" }}>
                    {result.confidence}%
                  </span>
                </div>
              </div>
            </div>

            <div className="findings-section">
              <div className="findings-title">Diagnostic Findings</div>
              {result.signals?.map((s, i) => (
                <div className="finding-row" key={i}>
                  <div className="finding-num">0{i + 1}</div>
                  <div className="finding-text">{s}</div>
                </div>
              ))}
            </div>

            {/* BUG FIX: use parseFavor to handle "null" string */}
            {result.stars < 5 && favor ? (
              <div className={`iou-box ${newFavor ? "new-favor" : ""}`}>
                <div className="iou-top">
                  <div className="iou-label">{favorMsg}</div>
                  <div className="iou-badge">I.O.U.</div>
                </div>
                <div className="iou-text">"{favor}"</div>
                {favorCount > 0 && (
                  <div className="iou-tally">
                    Cumulative institutional debt: {favorCount} favor{favorCount !== 1 ? "s" : ""}
                  </div>
                )}
              </div>
            ) : result.stars === 5 ? (
              <div className="five-star-box">
                ★ Exemplary submission. No institutional debt incurred. The record stands unblemished.
              </div>
            ) : null}

            <div style={{ display: "flex", gap: 10 }}>
              <button className="iai-btn" onClick={reset}><span>New Assessment</span></button>
            </div>
          </div>
        )}

        {/* HISTORY */}
        <div className="history-toggle" onClick={() => setShowHistory(h => !h)}>
          <div className="history-toggle-label">
            Assessment Registry · {history.length} record{history.length !== 1 ? "s" : ""}
          </div>
          <div
            className="history-toggle-arrow"
            style={{ transform: showHistory ? "rotate(180deg)" : "none" }}
          >▼</div>
        </div>

        {showHistory && (
          <div className="history-list">
            {history.length === 0 ? (
              <div className="empty-history">No assessments on record.</div>
            ) : history.map((entry) => (
              <div className="history-entry" key={entry.id}>
                <div className={`he-verdict ${entry.verdict === "EQ" ? "he-eq" : "he-noeq"}`}>
                  <div className={`he-grade ${entry.verdict === "EQ" ? "he-grade-eq" : "he-grade-noeq"}`}>
                    {getLetterGrade(entry.eq_score)}
                  </div>
                </div>
                <div className="he-body">
                  <div className="he-place">{entry.place}</div>
                  <div className="he-meta">{entry.date} · {entry.verdict} · {entry.stars}★</div>
                </div>
                <div className="he-score">{entry.eq_score}/100</div>
              </div>
            ))}
          </div>
        )}

        <div className="footer-line">
          Institute for Affective Intelligence · EQ-7 Protocol · Powered by Claude
        </div>
      </div>
    </div>
  );
}
