// Camera catalog: which cameras can send photos to Darkroom Bridge, and how to set each one up.
// "ftp": built-in FTP over Wi-Fi (works like the Sony setup). "tether": no built-in FTP, so the camera's
// tethering app saves into a folder that Darkroom Bridge watches (hot folder).

const ENTER = `Enter what the <b>Darkroom Bridge panel</b> shows: server address, port <b>2121</b>, user name and password. Server type <b>FTP</b> (not SFTP/FTPS), <b>passive mode on</b>, destination folder left empty.`;

export const BRANDS = {
  sony: {
    name: "Sony", method: "ftp",
    models: ["α1 II", "α1", "α9 III", "α9 II", "α7 V", "α7 IV", "α7R V", "α7R IV", "α7S III", "α7C II", "α7CR", "α7 III",
             "FX3 / FX3A", "FX2", "FX30", "FX6", "ZV-E1"],
    steps: [
      `<b>MENU → Network → FTP Transfer → FTP Transfer Func. → Server Setting → Server 1</b> (older bodies: <b>Network → FTP Transfer Func.</b>).`,
      `Host = the address in the bridge panel, Port <b>2121</b>, User and Password from the panel, Secure Protocol <b>Off</b>, Passive Mode <b>On</b>.`,
      `Under <b>FTP Transfer Func.</b> set <b>FTP Function: On</b> and <b>Auto FTP Transfer: On</b>, and Transfer Target <b>JPEG</b> (or HEIF).`,
    ],
    note: "Older bodies (α7 III, α9 II) may need the latest system software for FTP.",
  },
  canon: {
    name: "Canon", method: "ftp",
    models: ["EOS R1", "EOS R3", "EOS R5 Mark II", "EOS R5", "EOS R5 C (photo mode)", "EOS R6 Mark III", "EOS R6 Mark II",
             "EOS R6", "EOS-1D X Mark III", "EOS 5D Mark IV"],
    steps: [
      `<b>MENU → Communication functions</b> (older bodies: <b>Wireless features</b>) <b>→ Transfer images to FTP server → Add a device</b>, and join the same Wi-Fi as your Mac.`,
      `FTP mode <b>FTP</b> → <b>Address setting</b>: the address from the bridge panel → <b>Port number</b> <b>2121</b> → <b>Passive mode: Enable</b> → <b>Login</b> with the user name and password from the panel → Target folder <b>Root folder</b>.`,
      `<b>FTP transfer settings → Automatic transfer: Enable</b>, and Images to transfer <b>JPEG</b> (or HEIF).`,
    ],
    note: "Error 41 (cannot connect to FTP server) usually means Passive mode is off.",
  },
  nikon: {
    name: "Nikon", method: "ftp",
    models: ["Z9", "Z8", "Z6III", "Z5II", "Zf"],
    steps: [
      `<b>MENU → Network menu → Connect to FTP server → Network settings → Create profile → Connection wizard</b>, and choose to connect through your existing Wi-Fi network.`,
      `Server type <b>FTP</b>, server address from the bridge panel, port <b>2121</b> (if the camera doesn't ask for a port, the bridge also listens on <b>21</b>). Log in with <b>Enter user ID</b> using the user name and password from the panel. Folder: the home folder.`,
      `<b>Connect to FTP server → Options → Auto upload: ON</b>. Upload JPEG (or HEIF).`,
    ],
    note: "Update to the latest camera firmware; it adds the port setting and fixes FTP issues.",
  },
  fujifilm: {
    name: "Fujifilm", method: "ftp",
    models: ["X-H2S", "X-H2", "GFX100 II", "GFX100S II"],
    steps: [
      `<b>MENU → Network/USB setting → Create/Edit connection setting</b>, pick a slot and choose <b>FTP</b>, then join the same Wi-Fi as your Mac.`,
      `<b>FTP server setting</b>: server address from the bridge panel, port <b>2121</b>, <b>passive mode on</b>, user name and password from the panel.`,
      `Select that connection setting, then turn on automatic transfer in the <b>FTP transfer</b> options. Send JPEG (or HEIF).`,
    ],
    note: "X-H2 and X-H2S need current firmware (or the FT-XH grip). Fujifilm bodies without an FTP menu can use the hot folder method.",
  },
  panasonic: { name: "Panasonic Lumix", method: "tether", app: "LUMIX Tether", models: ["S1RII", "S1II", "S5II / S5IIX", "GH7", "G9II", "S9"] },
  hasselblad: { name: "Hasselblad", method: "tether", app: "Phocus", models: ["X2D II 100C", "X2D 100C", "907X"] },
  leica: { name: "Leica", method: "tether", app: "Capture One or Lightroom Classic tethering", models: ["SL3", "SL2", "Q3", "M11"] },
  om: { name: "OM System / Olympus", method: "tether", app: "OM Capture", models: ["OM-1 Mark II", "OM-1", "OM-3"] },
  other: { name: "Another camera", method: "other", models: [] },
};

const TETHER_STEPS = (app) => [
  `This camera doesn't send photos over Wi-Fi FTP, so connect it to your Mac with a <b>USB cable</b> and shoot tethered in <b>${app}</b>.`,
  `In ${app}, choose a folder where captures are saved (for example <b>Pictures → Tethered</b>).`,
  `In the <b>Darkroom Bridge panel</b>, enter that folder under <b>Hot folder</b> and click <b>Watch</b>. Every new capture develops in the connected shoot.`,
];
const OTHER_STEPS = [
  `<b>If your camera has an FTP menu</b> (look under Network or Wireless for “FTP”): ${ENTER} Then turn on automatic transfer of JPEGs.`,
  `<b>If it doesn't</b>, shoot tethered over USB with the maker's app or Capture One, save captures to a folder, and enter that folder under <b>Hot folder</b> in the Darkroom Bridge panel.`,
  `Older Canon, Nikon and Sony bodies without FTP work the same way with EOS Utility, NX Tether or Imaging Edge Desktop.`,
];

export function stepsFor(choice) {
  const b = BRANDS[choice?.brand];
  if (!b) return null;
  const model = choice.model && choice.model !== "_other" ? choice.model : "";
  const title = b.method === "other" ? "Any camera" : `${b.name}${model ? " " + model : ""}`;
  if (b.method === "ftp" && choice.model === "_other")
    return { title: `${b.name} (other model)`, method: "ftp", steps: [`If your ${b.name} has an FTP option in its network menu: ${ENTER}`, `Turn on automatic transfer and send JPEG.`, `No FTP option? Use the hot folder method with ${b.name}'s tethering app (see “Another camera”).`] };
  if (b.method === "ftp") return { title, method: "ftp", steps: b.steps, note: b.note };
  if (b.method === "tether") return { title, method: "tether", steps: TETHER_STEPS(b.app) };
  return { title, method: "other", steps: OTHER_STEPS };
}

export function pickerHtml(choice, esc) {
  const brand = choice?.brand || "";
  const models = BRANDS[brand]?.models || [];
  return `<div class="cam-pick" role="dialog" aria-modal="true" aria-labelledby="camq"><div class="cam-box card">
    <div class="label">One question</div><h3 class="card-h" id="camq">Which camera do you shoot with?</h3>
    <p class="muted">So we show the exact steps for your camera. You can change it any time.</p>
    <label class="cam-l">Brand<select class="select" id="camBrand"><option value="">Choose a brand…</option>
      ${Object.entries(BRANDS).map(([k, b]) => `<option value="${k}" ${k === brand ? "selected" : ""}>${esc(b.name)}</option>`).join("")}</select></label>
    <label class="cam-l" id="camModelL" ${models.length ? "" : "hidden"}>Model<select class="select" id="camModel">
      ${models.map((m) => `<option ${m === choice?.model ? "selected" : ""}>${esc(m)}</option>`).join("")}<option value="_other">Other model</option></select></label>
    <div class="kv" style="margin-top:14px"><button class="btn primary" id="camSave" ${brand ? "" : "disabled"}>Show my steps</button>
      <button class="btn ghost" id="camSkip">Not now</button></div></div></div>`;
}
