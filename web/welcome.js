// Welcome experience: a slowly turning ring of prints in 3D (pure CSS, no WebGL) and a quote
// that changes on every visit.

export const QUOTES = [
  ["You don't take a photograph, you make it.", "Ansel Adams"],
  ["There are no rules for good photographs, there are only good photographs.", "Ansel Adams"],
  ["When words become unclear, I shall focus with photographs.", "Ansel Adams"],
  ["A photograph is a secret about a secret.", "Diane Arbus"],
  ["Your first 10,000 photographs are your worst.", "Henri Cartier-Bresson"],
  ["If your pictures aren't good enough, you're not close enough.", "Robert Capa"],
  ["The camera is an instrument that teaches people how to see without a camera.", "Dorothea Lange"],
  ["Photography takes an instant out of time, altering life by holding it still.", "Dorothea Lange"],
  ["Which of my photographs is my favorite? The one I'm going to take tomorrow.", "Imogen Cunningham"],
  ["Taking pictures is savoring life intensely, every hundredth of a second.", "Marc Riboud"],
  ["Look and think before opening the shutter.", "Yousuf Karsh"],
  ["Light makes photography. Embrace light.", "George Eastman"],
  ["A good snapshot keeps a moment from running away.", "Eudora Welty"],
  ["The eye should learn to listen before it looks.", "Robert Frank"],
  ["Photography is the story I fail to put into words.", "Destin Sparks"],
  ["Every frame is a small act of remembering.", "Darkroom"],
  ["Develop slowly. The best images take their time.", "Darkroom"],
  ["Shoot what you feel, not what you see.", "Darkroom"],
  ["Somewhere between the shutter and the print, a memory is born.", "Darkroom"],
  ["Chase the light. Keep the moment.", "Darkroom"],
];

export function pickQuote() {
  let last = -1;
  try { const v = sessionStorage.getItem("darkroom:q"); if (v !== null) last = +v; } catch {}
  let i = Math.floor(Math.random() * QUOTES.length);
  if (i === last) i = (i + 1) % QUOTES.length;
  try { sessionStorage.setItem("darkroom:q", String(i)); } catch {}
  return QUOTES[i];
}

// Film-tone gradients for when there are no photos yet (sign-in screen, empty accounts).
const TONES = [
  ["#f7b267", "#f25c54", "#3d1d2a"], ["#a8dadc", "#457b9d", "#1d3557"], ["#e9c46a", "#2a9d8f", "#264653"],
  ["#ffcdb2", "#e5989b", "#6d6875"], ["#cdb4db", "#a2d2ff", "#3a3c6e"], ["#f4a261", "#e76f51", "#2b2d42"],
  ["#d8e2dc", "#9d8189", "#432f3a"], ["#fefae0", "#dda15e", "#606c38"], ["#caf0f8", "#48cae4", "#03045e"],
  ["#ffd6a5", "#fdffb6", "#7a6c5d"], ["#ffafcc", "#bde0fe", "#4a4e69"], ["#ede0d4", "#b08968", "#3c2f2f"],
];
const toneBg = ([a, b, c], i) =>
  `radial-gradient(120% 90% at ${20 + (i * 17) % 60}% ${15 + (i * 23) % 40}%, ${a} 0%, transparent 55%),` +
  `radial-gradient(90% 80% at ${70 - (i * 13) % 40}% 85%, ${b} 0%, transparent 60%), linear-gradient(160deg, ${b}, ${c})`;

export function prints3d(images = [], { count = 12, size = "md" } = {}) {
  const n = Math.max(6, Math.min(count, 14));
  const stage = document.createElement("div");
  stage.className = `stage3d ${size}`;
  stage.setAttribute("aria-hidden", "true");
  const ring = document.createElement("div");
  ring.className = "ring";
  ring.style.setProperty("--n", n);
  for (let i = 0; i < n; i++) {
    const f = document.createElement("figure");
    f.className = "print";
    f.style.setProperty("--i", i);
    const img = images.length ? images[i % images.length] : null;
    f.style.backgroundImage = img ? `url("${img}")` : toneBg(TONES[i % TONES.length], i);
    if (!img) f.classList.add("tone");
    ring.append(f);
  }
  stage.append(ring);
  // gentle parallax tilt that follows the pointer
  const move = (e) => {
    const r = stage.getBoundingClientRect();
    const x = ((e.clientX - r.left) / r.width - 0.5), y = ((e.clientY - r.top) / r.height - 0.5);
    stage.style.setProperty("--tx", `${(-y * 10).toFixed(2)}deg`);
    stage.style.setProperty("--ty", `${(x * 14).toFixed(2)}deg`);
  };
  addEventListener("pointermove", move, { passive: true });
  stage._cleanup = () => removeEventListener("pointermove", move);
  return stage;
}

export function quoteEl([text, who]) {
  const q = document.createElement("figure");
  q.className = "quote";
  q.innerHTML = `<blockquote></blockquote><figcaption></figcaption>`;
  q.querySelector("blockquote").textContent = `“${text}”`;
  q.querySelector("figcaption").textContent = `— ${who}`;
  return q;
}

export function greeting(name) {
  const h = new Date().getHours();
  const part = h < 5 ? "Working late" : h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening";
  return name ? `${part}, ${name}` : part;
}
