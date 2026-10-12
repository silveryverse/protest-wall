/* THE LOUDSPEAKER — browser-only frontend. */
import {
  CATEGORIES,
  categoryForPost,
  filterForView,
  filterPosts,
  normaliseCategory,
  routeForView,
  sortPosts,
  viewFromHash,
} from "./feed-model.js";

const POSTER_EXAMPLES = [
  { className: "poster-art--red", text: "SAVE THE RECEIPTS.", caption: "Design example — not a submission" },
  { className: "poster-art--yellow", text: "LESS SPIN. MORE ANSWERS.", caption: "Design example — not a submission" },
  { className: "poster-art--ink", text: "DISSENT IS NOT A TYPO.", caption: "Design example — not a submission" },
];

const state = {
  posts: [],
  config: null,
  feedLoaded: false,
  search: "",
  filter: "all",
  sort: "newest",
  view: "home",
  saved: new Set(),
  adminPosts: [],
  adminFilter: "pending",
  adminAuthenticated: false,
};

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

function makeElement(tag, className, content) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (content !== undefined && content !== null) node.textContent = String(content);
  return node;
}

function append(parent, ...children) {
  children.forEach((child) => {
    if (child) parent.append(child);
  });
  return parent;
}

function clear(node) {
  if (node) node.replaceChildren();
}

function setText(selector, value, root = document) {
  const node = typeof selector === "string" ? $(selector, root) : selector;
  if (node) node.textContent = value == null ? "" : String(value);
  return node;
}

function setStatus(selector, message, kind = "") {
  const node = typeof selector === "string" ? $(selector) : selector;
  if (!node) return;
  node.textContent = message || "";
  if (kind) node.dataset.state = kind;
  else delete node.dataset.state;
}

function showToast(message, kind = "") {
  const toast = $("#toast");
  if (!toast) return;
  toast.textContent = message || "";
  if (kind) toast.dataset.state = kind;
  else delete toast.dataset.state;
  toast.hidden = !message;
  if (message) {
    window.clearTimeout(showToast.timeout);
    showToast.timeout = window.setTimeout(() => {
      toast.hidden = true;
      toast.textContent = "";
    }, 5000);
  }
}

function safeStorage() {
  try {
    const key = "loudspeaker:saved";
    return {
      read() {
        try {
          const value = JSON.parse(window.localStorage.getItem(key) || "[]");
          return new Set(Array.isArray(value) ? value.filter((id) => typeof id === "string") : []);
        } catch (_) {
          return new Set();
        }
      },
      write(ids) {
        try {
          window.localStorage.setItem(key, JSON.stringify(Array.from(ids)));
        } catch (_) {
          // Private browsing and blocked storage should not break the feed.
        }
      },
    };
  } catch (_) {
    return { read: () => new Set(), write: () => {} };
  }
}

const storage = safeStorage();
state.saved = storage.read();

function readableError(error, fallback = "Something went wrong. Please try again.") {
  if (error && typeof error.message === "string" && error.message.trim()) return error.message;
  return fallback;
}

async function request(path, options = {}) {
  const init = { credentials: "same-origin", ...options, headers: { Accept: "application/json", ...(options.headers || {}) } };
  if (init.body && typeof init.body !== "string") {
    init.body = JSON.stringify(init.body);
    init.headers["Content-Type"] = "application/json";
  }
  let response;
  try {
    response = await fetch(path, init);
  } catch (_) {
    throw new Error("Unable to reach the Loudspeaker. Check your connection and try again.");
  }
  let payload = null;
  try {
    payload = await response.json();
  } catch (_) {
    payload = null;
  }
  if (!response.ok) {
    const message = payload && (payload.message || payload.error);
    throw new Error(message || `Request failed (${response.status}).`);
  }
  return payload || {};
}

function validHttpUrl(value) {
  if (!value || typeof value !== "string") return null;
  try {
    const url = new URL(value.trim());
    const host = url.hostname.toLowerCase().replace(/\.$/, "");
    if (url.protocol !== "https:" || url.username || url.password || !host.includes(".") ||
        host === "localhost" || /(?:^|\.)(?:localhost|local|internal)$/.test(host) ||
        /^\d+(?:\.\d+)*$/.test(host) || host.startsWith("[") || url.port) return null;
    return url.href;
  } catch (_) {
    return null;
  }
}

function hostIs(host, domain) {
  return host === domain || host.endsWith(`.${domain}`);
}

// Classification uses the URL alone: no oEmbed, scraping, image probe or external request.
function detectLink(value) {
  const href = validHttpUrl(value);
  if (!href) return null;
  const url = new URL(href);
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  const path = url.pathname;
  if ((hostIs(host, "youtube.com") && (url.searchParams.get("v") && path === "/watch" ||
      /^\/(?:shorts|embed|live)\/[^/]+/.test(path))) || (host === "youtu.be" && path.length > 1)) {
    return { href, host, type: "video", label: "YouTube", note: "Video opens here only if you choose Load YouTube video." };
  }
  if ((hostIs(host, "x.com") || hostIs(host, "twitter.com")) && /\/status\/\d+(?:\/|$)/.test(path)) {
    return { href, host, type: "video", label: "X / Twitter", note: "Original post link. No third-party embed is loaded here." };
  }
  if ((hostIs(host, "reddit.com") && /(?:^|\/)comments\/[a-z0-9]+(?:\/|$)/i.test(path)) ||
      (host === "redd.it" && /^\/[a-z0-9]+(?:\/|$)/i.test(path))) {
    return { href, host, type: "video", label: "Reddit", note: "Original discussion link. No third-party embed is loaded here." };
  }
  if (/\.(?:png|jpe?g|gif|webp|avif)(?:$)/i.test(path) ||
      hostIs(host, "images.unsplash.com") && path.startsWith("/photo-") ||
      hostIs(host, "i.redd.it") || hostIs(host, "i.imgur.com")) {
    return { href, host, type: "image", label: "Image / poster", note: "Direct image; it loads here only when you choose Load image." };
  }
  // A web page cannot be safely assumed to permit framing or to be an image.
  return { href, host, type: "text", label: "Web / news article", note: "Source card only: the page type is unverified without fetching it. Many news sites block iframes; no article text is fetched." };
}

function externalLink(label, value, className = "source-link") {
  const href = validHttpUrl(value);
  if (!href) return null;
  const link = makeElement("a", className, label || href);
  link.href = href;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  return link;
}

function formatDate(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(date);
}

function typeLabel(type) {
  return ({ text: "Text", video: "Video", image: "Image", poster: "Poster" })[type] || "Post";
}

function normalisePost(post) {
  if (!post || typeof post !== "object") return null;
  const id = typeof post.id === "string" || typeof post.id === "number" ? String(post.id) : "";
  if (!id) return null;
  return {
    ...post,
    id,
    type: ["text", "video", "image", "poster"].includes(post.type) ? post.type : "text",
    platform: typeof post.platform === "string" ? post.platform : "",
    title: typeof post.title === "string" ? post.title : "",
    text: typeof post.text === "string" ? post.text : "",
    url: typeof post.url === "string" ? post.url : "",
    author: typeof post.author === "string" ? post.author : "Anonymous",
    satire: Boolean(post.satire),
    category: normaliseCategory(post.category, post),
    status: typeof post.status === "string" ? post.status : "pending",
  };
}

function matchesPost(post) {
  return filterPosts([post], { filter: state.filter, search: state.search, saved: state.saved }).length > 0;
}

function statusTag(post) {
  if (!post.status || post.status === "approved") return null;
  return makeElement("span", "tag", post.status === "pending" ? "Pending moderation" : post.status);
}

function buildEmbed(post) {
  const detected = detectLink(post.url);
  const preview = makeElement("div", "embed-preview");
  const embedUrl = youtubeEmbedUrl(post.url) || socialEmbedUrl(post.url, detected?.label);
  if (!detected || detected.type === "text" || (post.type === "video" && !embedUrl)) {
    append(preview, makeElement("p", "media-note", detected?.note || "This source is available at its original link."), sourceLinkFor(post));
    return preview;
  }
  const imagePost = post.type === "image" || post.type === "poster";
  const load = makeElement("button", "embed-load", imagePost ? "Load image" : `Load ${detected.label || "media"}`);
  load.type = "button";
  load.addEventListener("click", () => {
    load.disabled = true;
    load.textContent = "Loading…";
    if (imagePost) {
      const imageUrl = detected.type === "image" ? detected.href : null;
      if (!imageUrl) {
        clear(preview);
        append(preview, makeElement("p", "media-note", "This image has no valid source URL."), sourceLinkFor(post));
        return;
      }
      const image = document.createElement("img");
      image.alt = post.title || "Submitted image";
      image.loading = "lazy";
      image.referrerPolicy = "no-referrer";
      image.src = imageUrl;
      image.addEventListener("error", () => {
        clear(preview);
        append(preview, makeElement("p", "media-note", "This image could not be loaded."), sourceLinkFor(post));
      }, { once: true });
      clear(preview);
      preview.append(image);
      return;
    }
    if (embedUrl) {
      const iframe = document.createElement("iframe");
      iframe.title = post.title || "Submitted video";
      iframe.src = embedUrl;
      iframe.loading = "lazy";
      iframe.referrerPolicy = "no-referrer";
      iframe.allow = "accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share";
      iframe.allowFullscreen = true;
      clear(preview);
      append(preview, iframe, sourceLinkFor(post));
      return;
    }
    clear(preview);
    append(preview, makeElement("p", "media-note", "This source is available at the original link."), sourceLinkFor(post));
  });
  preview.append(load);
  return preview;
}

function youtubeEmbedUrl(value) {
  const href = validHttpUrl(value);
  if (!href) return null;
  let url;
  try { url = new URL(href); } catch (_) { return null; }
  let id = "";
  if (url.hostname === "youtu.be") id = url.pathname.slice(1).split("/")[0];
  if (hostIs(url.hostname, "youtube.com")) {
    if (url.pathname === "/watch") id = url.searchParams.get("v") || "";
    if (url.pathname.startsWith("/shorts/")) id = url.pathname.split("/")[2] || "";
    if (url.pathname.startsWith("/embed/")) id = url.pathname.split("/")[2] || "";
    if (url.pathname.startsWith("/live/")) id = url.pathname.split("/")[2] || "";
  }
  if (!/^[A-Za-z0-9_-]{6,20}$/.test(id)) return null;
  return `https://www.youtube-nocookie.com/embed/${encodeURIComponent(id)}`;
}

function socialEmbedUrl(value, label = "") {
  const href = validHttpUrl(value);
  if (!href) return null;
  let url;
  try { url = new URL(href); } catch (_) { return null; }
  const host = url.hostname.toLowerCase();
  if ((hostIs(host, "x.com") || hostIs(host, "twitter.com")) && /\/status\/(\d+)(?:\/|$)/.test(url.pathname)) {
    const match = url.pathname.match(/\/status\/(\d+)(?:\/|$)/);
    return `https://platform.twitter.com/embed/Tweet.html?id=${encodeURIComponent(match[1])}&dnt=true`;
  }
  if (label === "Reddit" && (hostIs(host, "reddit.com") || host === "redd.it")) {
    const embed = new URL(`https://www.redditmedia.com${url.pathname}`);
    embed.searchParams.set("embed", "true");
    embed.searchParams.set("ref_source", "embed");
    embed.searchParams.set("ref", "share");
    return embed.href;
  }
  return null;
}

function sourceLinkFor(post) {
  return externalLink("Open original source", post.url) || makeElement("span", "media-note", "No valid source URL was provided.");
}

function buildPostCard(post) {
  const card = makeElement("article", "post-card");
  card.dataset.postId = post.id;
  const source = post.url ? detectLink(post.url) : null;
  const meta = makeElement("div", "post-meta");
  append(meta, makeElement("span", "tag", post.category === "news" ? "News / source" : post.category[0].toUpperCase() + post.category.slice(1)), statusTag(post));
  if (post.satire) append(meta, makeElement("span", "tag tag--red", "Satire"));
  const save = makeElement("button", "icon-button", state.saved.has(post.id) ? "Saved" : "Save");
  save.type = "button";
  save.setAttribute("aria-pressed", String(state.saved.has(post.id)));
  save.addEventListener("click", () => {
    if (state.saved.has(post.id)) state.saved.delete(post.id);
    else state.saved.add(post.id);
    storage.write(state.saved);
    renderFeed();
  });
  append(meta, save);

  const title = makeElement("h3", "post-title", post.title || "Untitled submission");
  const body = makeElement("div", "post-body");
  if (["video", "image", "poster"].includes(post.type) && post.url) body.append(buildEmbed(post));
  if (post.text) body.append(makeElement("p", "", post.text));
  if (post.type === "text" && post.url) {
    const article = makeElement("div", "source-card");
    append(article, makeElement("span", "tag", "ARTICLE / SOURCE"),
      makeElement("p", "media-note", `Source: ${source?.host || "external website"}. Article content is not fetched or embedded.`), sourceLinkFor(post));
    body.append(article);
  }

  const footer = makeElement("footer", "post-footer");
  if (post.author) footer.append(makeElement("span", "", `By ${post.author}`));
  const date = formatDate(post.createdAt);
  if (date) footer.append(makeElement("time", "", date));
  if (post.url && post.type !== "text") footer.append(sourceLinkFor(post));

  append(card, meta, title, body, footer);
  return card;
}

function renderFeed() {
  const feed = $("#feed");
  if (!feed) return;
  clear(feed);
  const visible = sortPosts(filterPosts(state.posts, { filter: state.filter, search: state.search, saved: state.saved }), state.sort);
  if (!visible.length) {
    const empty = makeElement("div", "empty-state");
    empty.append(makeElement("p", "", state.posts.length ? "No posts match this view." : "No live submissions yet."));
    if (CATEGORIES.includes(state.filter)) {
      const submit = makeElement("button", "text-link", `Submit a ${state.filter.slice(0, -1)} →`);
      submit.type = "button";
      submit.dataset.openSubmit = "";
      submit.dataset.category = state.filter;
      empty.append(submit);
    }
    feed.append(empty);
  } else {
    visible.forEach((post) => feed.append(buildPostCard(post)));
  }
  setText("#post-count", String(visible.length));
  const status = $("#feed-status");
  if (status) status.textContent = state.feedLoaded ? `${visible.length} post${visible.length === 1 ? "" : "s"} shown` : "Loading the wall…";
  $$("#feed-filters [data-filter]").forEach((button) => {
    const selected = button.dataset.filter === state.filter;
    button.classList.toggle("is-active", selected);
    button.setAttribute("aria-pressed", String(selected));
  });
}

function renderView() {
  const homeIntro = $("#home-intro");
  const wall = $("#wall");
  const posters = $("#posters");
  const manifesto = $("#manifesto");
  if (homeIntro) homeIntro.hidden = state.view !== "home";
  if (wall) wall.hidden = false;
  if (posters) posters.hidden = !["home", "posters"].includes(state.view);
  if (manifesto) manifesto.hidden = state.view !== "home" && state.view !== "manifesto";
  setText("#wall-heading", state.view === "home" ? "The public noticeboard." : `${state.view} on the wall.`);
  setText("#wall-description", state.view === "home" ? "Human-reviewed submissions, sources, satire and community voices." : `Human-reviewed ${state.view} submissions.`);
  state.filter = filterForView(state.view);
  renderFeed();
  $$("[data-view]").forEach((link) => {
    const active = link.dataset.view === state.view;
    link.classList.toggle("is-active", active);
    if (active) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  });
}

function renderPosters() {
  const gallery = $("#poster-gallery");
  if (!gallery) return;
  clear(gallery);
  POSTER_EXAMPLES.forEach((poster) => {
    const card = makeElement("article", "poster-card");
    const art = makeElement("div", `poster-art ${poster.className}`, poster.text);
    art.setAttribute("role", "img");
    art.setAttribute("aria-label", poster.text);
    append(card, art, makeElement("p", "poster-caption", poster.caption));
    gallery.append(card);
  });
  state.posts.filter((post) => categoryForPost(post) === "posters").forEach((post) => {
    const card = makeElement("article", "poster-card poster-card--live");
    const heading = makeElement("h3", "poster-live-title", post.title || "Community poster");
    append(card, heading, buildEmbed({ ...post, type: "poster" }), makeElement("p", "poster-caption", "Community submission — approved"));
    gallery.append(card);
  });
}

function renderManifesto() {
  const content = $("#manifesto-content");
  const source = $("#manifesto-source");
  const status = $("#manifesto-status");
  clear(content);
  clear(source);
  if (!state.config || !state.config.confirmed) {
    if (content) content.append(makeElement("p", "empty-state", "Source-backed CJP information is awaiting review. No claims are displayed until a source is confirmed."));
    setStatus(status, "Awaiting confirmation", "pending");
    return;
  }
  if (content && state.config.summary) content.append(makeElement("p", "", state.config.summary));
  const demands = Array.isArray(state.config.demands) ? state.config.demands : [];
  if (content && demands.length) {
    const list = document.createElement("ul");
    demands.forEach((demand) => {
      if (!demand || typeof demand !== "object") return;
      const item = document.createElement("li");
      append(item, makeElement("strong", "", demand.title || ""), makeElement("span", "", demand.detail || ""));
      list.append(item);
    });
    content.append(list);
  }
  if (source) {
    const link = externalLink("Read the original source", state.config.sourceUrl);
    if (link) source.append(link);
  }
  setStatus(status, "Confirmed source", "confirmed");
}

function renderMotiveSidebar() {
  const summary = state.config?.summary || "Source-backed CJP information is awaiting review.";
  const firstSentence = summary.match(/^[^.!?]+[.!?]/)?.[0] || summary;
  setText("#motive-summary", firstSentence);
  const demandTarget = $("#motive-demands");
  clear(demandTarget);
  (Array.isArray(state.config?.demands) ? state.config.demands : []).forEach((demand) => {
    if (demand?.title) demandTarget?.append(makeElement("li", "", demand.title));
  });
  setStatus("#motive-status", state.config?.confirmed ? "Confirmed source" : "Awaiting confirmation", state.config?.confirmed ? "confirmed" : "pending");
}

async function loadPublicPosts() {
  renderPosters();
  renderFeed();
  try {
    const payload = await request("/api/posts");
    state.posts = Array.isArray(payload.posts) ? payload.posts.map(normalisePost).filter(Boolean) : [];
    state.feedLoaded = true;
    renderPosters();
    renderFeed();
  } catch (error) {
    state.feedLoaded = true;
    renderFeed();
    setStatus("#feed-status", readableError(error), "error");
  }
}

async function loadPublic() {
  await loadPublicPosts();
  try {
    const payload = await request("/api/config");
    state.config = payload && payload.config && typeof payload.config === "object" ? payload.config : { confirmed: false };
    renderManifesto();
    renderMotiveSidebar();
  } catch (error) {
    state.config = { confirmed: false };
    renderManifesto();
    renderMotiveSidebar();
    setStatus("#manifesto-status", readableError(error), "error");
  }
}

function dialogFor(node) {
  return node && node.closest ? node.closest("dialog") : null;
}

function openDialog(dialog) {
  if (!dialog) return;
  if (typeof dialog.showModal === "function" && !dialog.open) dialog.showModal();
  else dialog.setAttribute("open", "");
}

function closeDialog(dialog) {
  if (!dialog) return;
  if (typeof dialog.close === "function" && dialog.open) dialog.close();
  else dialog.removeAttribute("open");
}

function setupDialogBehavior() {
  document.addEventListener("click", (event) => {
    const openButton = event.target.closest("[data-open-submit], [data-open-admin]");
    if (openButton) {
      event.preventDefault();
      if (openButton.matches("[data-open-admin]")) {
        openDialog($("#admin-dialog"));
        checkAdminSession();
      } else {
        const dialog = $("#submit-dialog");
        openDialog(dialog);
        const category = openButton.dataset.category || (openButton.dataset.type === "poster" ? "posters" : "auto");
        const categoryField = $("#submit-category");
        if (categoryField) categoryField.value = category;
        const posterInput = $("#poster-input");
        if (posterInput && category === "posters") posterInput.checked = true;
        $("#url-input")?.focus();
      }
      return;
    }
    const closeButton = event.target.closest("[data-close-dialog]");
    if (closeButton) {
      event.preventDefault();
      closeDialog(dialogFor(closeButton));
      return;
    }
  });
  $$('dialog').forEach((dialog) => {
    dialog.addEventListener("click", (event) => {
      if (event.target === dialog) closeDialog(dialog);
    });
  });
}

function setupFeedControls() {
  $$("#feed-filters [data-filter]").forEach((button) => {
    button.addEventListener("click", () => {
      state.filter = button.dataset.filter || "all";
      renderFeed();
    });
  });
  $("#feed-sort")?.addEventListener("change", (event) => {
    state.sort = event.target.value === "oldest" ? "oldest" : "newest";
    renderFeed();
  });
  const search = $("#feed-search");
  if (search) search.addEventListener("input", () => {
    state.search = search.value || "";
    renderFeed();
  });
  $("[data-mobile-filter=\"saved\"]")?.addEventListener("click", () => {
    state.view = "home";
    if (window.location.hash !== "#home") window.history.pushState({}, "", "#home");
    renderView();
    state.filter = "saved";
    renderFeed();
    $("#wall")?.scrollIntoView({ block: "start" });
  });
}

function setupNavigation() {
  document.addEventListener("click", (event) => {
    const link = event.target.closest("[data-view]");
    if (!link) return;
    const view = viewFromHash(link.getAttribute("href") || routeForView(link.dataset.view));
    if (link.getAttribute("href") === routeForView(view)) {
      event.preventDefault();
      if (window.location.hash !== routeForView(view)) window.history.pushState({}, "", routeForView(view));
      applyHashRoute();
    }
  });
}

function applyHashRoute() {
  const raw = window.location.hash.toLowerCase();
  if (raw === "#admin") {
    openDialog($("#admin-dialog"));
    checkAdminSession();
    return;
  }
  closeDialog($("#admin-dialog"));
  if (raw === "#manifesto") {
    state.view = "home";
    const details = $("#manifesto");
    if (details && details.tagName.toLowerCase() === "details") details.open = true;
  } else {
    state.view = viewFromHash(raw);
  }
  renderView();
  if (raw === "#manifesto") $("#manifesto")?.scrollIntoView({ block: "start" });
  else if (state.view !== "home") $("#wall")?.scrollIntoView({ block: "start" });
}

function setupSubmit() {
  const form = $("#submit-form");
  if (!form) return;
  let mode = "link";
  const urlField = $("#url-field");
  const urlInput = $("#url-input");
  const textInput = $("#text-input");
  const preview = $("#link-preview");
  const posterField = $("#poster-field");
  const posterInput = $("#poster-input");
  const categoryInput = $("#submit-category");
  const showPreview = () => {
    clear(preview);
    const value = urlInput.value.trim();
    const link = detectLink(value);
    preview.hidden = !value || mode !== "link";
    posterField.hidden = !link || link.type !== "image" || mode !== "link";
    if (!link) {
      if (value) preview.append(makeElement("p", "form-status", "Use a public HTTPS link. Nothing has been fetched."));
      return;
    }
    const card = makeElement("div", "post-card");
    const label = link.type === "image" && posterInput.checked ? "Poster" : link.label;
    append(card, makeElement("span", "tag", label),
      makeElement("h3", "post-title", `Source: ${link.host}`),
      makeElement("p", "media-note", link.note), sourceLinkFor({ url: link.href }));
    // The preview itself is consent-gated; social/article pages are never fetched by the server.
    if (link.type === "image" || youtubeEmbedUrl(link.href) || socialEmbedUrl(link.href, link.label)) {
      card.append(buildEmbed({ url: link.href, type: link.type, title: "Submission preview" }));
    }
    preview.append(card);
  };
  const setMode = (next) => {
    mode = next;
    urlField.hidden = next !== "link";
    $("#text-field").hidden = next !== "text";
    $("#note-field").hidden = next === "text";
    urlInput.required = next === "link";
    textInput.required = next === "text";
    for (const value of ["link", "text"]) {
      const button = $(`#mode-${value}`);
      button.classList.toggle("is-active", value === next);
      button.setAttribute("aria-pressed", String(value === next));
    }
    showPreview();
    (next === "link" ? urlInput : textInput).focus();
  };
  $("#mode-link").addEventListener("click", () => setMode("link"));
  $("#mode-text").addEventListener("click", () => setMode("text"));
  urlInput.addEventListener("input", showPreview);
  posterInput.addEventListener("change", showPreview);
  showPreview();
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const send = $("#submit-send") || form.querySelector('[type="submit"]');
    const status = $("#submit-status");
    const link = mode === "link" ? detectLink(urlInput.value) : null;
    if (mode === "link" && !link) { setStatus(status, "Paste a valid public HTTPS link to see its preview.", "error"); return; }
    const words = textInput.value.trim();
    if (mode === "text" && !words) { setStatus(status, "Write your post before sending.", "error"); return; }
    const note = String(form.elements.namedItem("note")?.value || "").trim();
     const selectedCategory = categoryInput?.value || "auto";
     const selectedType = mode === "text" ? "text" : link.type === "image" && (posterInput.checked || selectedCategory === "posters") ? "poster" : link.type;
    const title = String(form.elements.namedItem("title")?.value || "").trim() ||
      (mode === "text" ? words.slice(0, 120) : `${selectedType === "poster" ? "Poster" : link.label} from ${link.host}`.slice(0, 120));
    const text = mode === "text" ? words : link.type === "text" ? note || `Article link from ${link.host}. Open the original source to read it.` : note;
    if (send) send.disabled = true;
    setStatus(status, "Sending for moderation…", "loading");
    const payload = {
      type: selectedType,
      title,
      text,
      url: link?.href || "",
      author: String(form.elements.namedItem("author")?.value || "").trim(),
       satire: Boolean(form.elements.namedItem("satire")?.checked),
       category: selectedCategory,
    };
    try {
      await request("/api/posts", { method: "POST", body: payload });
      form.reset();
      setMode("link");
      setStatus(status, "Received — your submission is pending moderation.", "success");
      showToast("Submission received and queued for moderation.", "success");
    } catch (error) {
      setStatus(status, readableError(error), "error");
    } finally {
      if (send) send.disabled = false;
    }
  });
}

function setAdminVisibility(authenticated) {
  const login = $("#admin-login-panel");
  const workspace = $("#admin-workspace");
  if (login) login.hidden = authenticated;
  if (workspace) workspace.hidden = !authenticated;
}

function adminPostCard(post) {
  const card = makeElement("article", "post-card admin-post-card");
  card.dataset.status = post.status || "pending";
  const heading = makeElement("h3", "post-title", post.title || "Untitled submission");
  const meta = makeElement("div", "post-meta");
  append(meta, makeElement("span", "tag", post.category === "news" ? "News / source" : post.category[0].toUpperCase() + post.category.slice(1)), makeElement("span", "tag", post.status || "pending"));
  if (post.satire) meta.append(makeElement("span", "tag tag--red", "Satire"));
  const body = makeElement("div", "post-body");
  if (post.url && ["video", "image", "poster"].includes(post.type)) body.append(buildEmbed(post));
  if (post.text) body.append(makeElement("p", "", post.text));
  else if (post.url) body.append(sourceLinkFor(post));
  const controls = makeElement("div", "post-footer");
  ["approved", "rejected", "pending"].forEach((status) => {
    const button = makeElement("button", "icon-button", status[0].toUpperCase() + status.slice(1));
    button.type = "button";
    button.disabled = post.status === status;
    button.addEventListener("click", () => updateAdminPost(post.id, status));
    controls.append(button);
  });
  const remove = makeElement("button", "icon-button", "Delete");
  remove.type = "button";
  remove.addEventListener("click", () => {
    if (window.confirm("Permanently delete this submission?")) deleteAdminPost(post.id);
  });
  controls.append(remove);
  append(card, meta, heading, body, controls);
  return card;
}

function renderAdminPosts() {
  const target = $("#admin-posts");
  if (!target) return;
  clear(target);
  const filtered = state.adminPosts.filter((post) => state.adminFilter === "all" || post.status === state.adminFilter);
  if (!filtered.length) {
    target.append(makeElement("p", "empty-state", "No submissions in this queue."));
  } else {
    filtered.forEach((post) => target.append(adminPostCard(post)));
  }
  const counts = ["pending", "approved", "rejected"].map((status) => `${status}: ${state.adminPosts.filter((post) => post.status === status).length}`);
  setStatus("#admin-status", counts.join(" · "));
}

async function loadAdminPosts() {
  setStatus("#admin-status", "Loading moderation queue…", "loading");
  try {
    const payload = await request("/api/admin/posts");
    state.adminPosts = Array.isArray(payload.posts) ? payload.posts.map(normalisePost).filter(Boolean) : [];
    renderAdminPosts();
  } catch (error) {
    state.adminPosts = [];
    clear($("#admin-posts"));
    $("#admin-posts")?.append(makeElement("p", "empty-state", readableError(error)));
    setStatus("#admin-status", readableError(error), "error");
  }
}

async function updateAdminPost(id, status) {
  try {
    await request(`/api/admin/posts/${encodeURIComponent(id)}`, { method: "PATCH", body: { status } });
    await loadAdminPosts();
    await loadPublicPosts();
    showToast(`Post marked ${status}.`, "success");
  } catch (error) {
    setStatus("#admin-status", readableError(error), "error");
  }
}

async function deleteAdminPost(id) {
  try {
    await request(`/api/admin/posts/${encodeURIComponent(id)}`, { method: "DELETE" });
    await loadAdminPosts();
    await loadPublicPosts();
    showToast("Submission deleted.", "success");
  } catch (error) {
    setStatus("#admin-status", readableError(error), "error");
  }
}

function populateConfigForm() {
  const form = $("#admin-config-form");
  if (!form || !state.config) return;
  const summary = form.elements.namedItem("summary");
  const demands = form.elements.namedItem("demands");
  const sourceUrl = form.elements.namedItem("sourceUrl");
  const confirmed = form.elements.namedItem("confirmed");
  if (summary) summary.value = state.config.summary || "";
  if (demands) demands.value = (Array.isArray(state.config.demands) ? state.config.demands : []).map((demand) => `${demand.title || ""} | ${demand.detail || ""}`).join("\n");
  if (sourceUrl) sourceUrl.value = state.config.sourceUrl || "";
  if (confirmed) confirmed.checked = Boolean(state.config.confirmed);
}

function setupAdmin() {
  setAdminVisibility(false);
  const loginForm = $("#admin-login-form");
  loginForm?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const status = $("#admin-login-status");
    const submit = loginForm.querySelector('[type="submit"]');
    const password = String(loginForm.elements.namedItem("password")?.value || "");
    if (!password) { setStatus(status, "Enter the admin password.", "error"); return; }
    if (submit) submit.disabled = true;
    setStatus(status, "Checking credentials…", "loading");
    try {
      await request("/api/admin/login", { method: "POST", body: { password } });
      loginForm.reset();
      state.adminAuthenticated = true;
      setAdminVisibility(true);
      await loadAdminPosts();
      populateConfigForm();
      setStatus(status, "");
    } catch (error) {
      state.adminAuthenticated = false;
      setAdminVisibility(false);
      setStatus(status, readableError(error), "error");
    } finally {
      if (submit) submit.disabled = false;
    }
  });
  $("#admin-logout")?.addEventListener("click", async () => {
    const button = $("#admin-logout");
    if (button) button.disabled = true;
    try {
      await request("/api/admin/logout", { method: "POST" });
      state.adminAuthenticated = false;
      setAdminVisibility(false);
      setStatus("#admin-login-status", "Signed out.", "success");
    } catch (error) {
      setStatus("#admin-status", readableError(error), "error");
    } finally {
      if (button) button.disabled = false;
    }
  });
  $("#admin-refresh")?.addEventListener("click", loadAdminPosts);
  $("#admin-filter")?.addEventListener("change", (event) => {
    state.adminFilter = event.target.value || "pending";
    renderAdminPosts();
  });
  $("#admin-config-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const status = $("#config-status");
    const submit = form.querySelector('[type="submit"]');
    const lines = String(form.elements.namedItem("demands")?.value || "").split("\n").map((line) => line.trim()).filter(Boolean);
    const demands = lines.map((line) => {
      const divider = line.indexOf("|");
      return divider < 0 ? { title: line, detail: "" } : { title: line.slice(0, divider).trim(), detail: line.slice(divider + 1).trim() };
    }).filter((demand) => demand.title);
    const sourceUrl = String(form.elements.namedItem("sourceUrl")?.value || "").trim();
    if (sourceUrl && !validHttpUrl(sourceUrl)) { setStatus(status, "Source URL must use http(s).", "error"); return; }
    if (submit) submit.disabled = true;
    setStatus(status, "Saving manifesto…", "loading");
    try {
      const payload = {
        summary: String(form.elements.namedItem("summary")?.value || "").trim(),
        demands,
        sourceUrl,
        confirmed: Boolean(form.elements.namedItem("confirmed")?.checked),
      };
      await request("/api/admin/config", { method: "PUT", body: payload });
      state.config = payload;
      renderManifesto();
      setStatus(status, "Manifesto saved.", "success");
    } catch (error) {
      setStatus(status, readableError(error), "error");
    } finally {
      if (submit) submit.disabled = false;
    }
  });
}

async function checkAdminSession() {
  setAdminVisibility(false);
  setStatus("#admin-login-status", "Checking admin session…", "loading");
  try {
    const session = await request("/api/admin/session");
    if (!session.configured) {
      setStatus("#admin-login-status", "Admin access is not configured yet.", "error");
      return;
    }
    state.adminAuthenticated = Boolean(session.authenticated);
    setAdminVisibility(state.adminAuthenticated);
    if (state.adminAuthenticated) {
      await loadAdminPosts();
      populateConfigForm();
      setStatus("#admin-login-status", "");
    } else {
      setStatus("#admin-login-status", "Sign in to moderate submissions.");
    }
  } catch (error) {
    setStatus("#admin-login-status", readableError(error), "error");
  }
}

function setupHashRoute() {
  window.addEventListener("hashchange", applyHashRoute);
  window.addEventListener("popstate", applyHashRoute);
  applyHashRoute();
}

function boot() {
  setupDialogBehavior();
  setupFeedControls();
  setupNavigation();
  setupSubmit();
  setupAdmin();
  loadPublic();
  setupHashRoute();
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot, { once: true });
else boot();
