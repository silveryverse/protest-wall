export const CATEGORIES = Object.freeze(["protests", "memes", "posters", "news"]);
export const FEED_FILTERS = Object.freeze(["all", ...CATEGORIES, "video", "saved"]);
export const VIEWS = Object.freeze(["home", ...CATEGORIES.filter((category) => category !== "news")]);

export function inferCategory(post = {}) {
  post = post && typeof post === "object" ? post : {};
  const type = String(post.type || "").toLowerCase();
  if (type === "poster") return "posters";
  if (post.satire === true) return "memes";
  if ((type === "article" || type === "text") && String(post.url || "").trim()) return "news";
  return "protests";
}

export function categoryForPost(post = {}) {
  const candidate = post && typeof post === "object" ? post : {};
  return CATEGORIES.includes(candidate.category) ? candidate.category : inferCategory(candidate);
}

export function normaliseCategory(value, post = {}) {
  return value === "auto" || !CATEGORIES.includes(value) ? inferCategory(post) : value;
}

export function filterPosts(posts, { filter = "all", search = "", saved = new Set() } = {}) {
  const query = String(search || "").trim().toLocaleLowerCase();
  return posts.filter((post) => {
    if (filter === "saved" && !saved.has(String(post.id))) return false;
    if (CATEGORIES.includes(filter) && categoryForPost(post) !== filter) return false;
    if (filter === "video" && post.type !== "video") return false;
    if (filter === "text" && post.type !== "text") return false;
    if (filter === "image" && !["image", "poster"].includes(post.type)) return false;
    if (!query) return true;
    return [post.title, post.text, post.author, post.type, post.category, post.url, post.platform]
      .some((value) => String(value || "").toLocaleLowerCase().includes(query));
  });
}

export function sortPosts(posts, sort = "newest") {
  const direction = sort === "oldest" ? 1 : -1;
  return [...posts].sort((a, b) => {
    const left = Date.parse(a.createdAt || "") || 0;
    const right = Date.parse(b.createdAt || "") || 0;
    return (left - right) * direction;
  });
}

export function viewFromHash(hash = "") {
  const value = String(hash).replace(/^#/, "").toLowerCase();
  if (VIEWS.includes(value)) return value;
  return "home";
}

export function filterForView(view) {
  return CATEGORIES.includes(view) && view !== "news" ? view : "all";
}

export function routeForView(view) {
  return `#${VIEWS.includes(view) ? view : "home"}`;
}
