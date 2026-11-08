// 비공개 저장소를 GitHub API 로 읽고 쓴다. 토큰은 이 기기(localStorage)에만 저장된다.
// 이 공개 앱 코드에는 저장소 이름도 토큰도 들어 있지 않다.

const API = "https://api.github.com";

export class AuthError extends Error {}
export class ConflictError extends Error {}

function b64encode(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
function b64decode(b64) {
  const bin = atob(b64.replace(/\s/g, ""));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

export class Repo {
  constructor(fullName, token) {
    this.full = fullName.trim().replace(/^https?:\/\/github\.com\//, "").replace(/\.git$/, "").replace(/\/+$/, "");
    this.token = token.trim();
  }

  url(path) {
    return `${API}/repos/${this.full}/contents/${path.split("/").map(encodeURIComponent).join("/")}`;
  }

  async req(path, { method = "GET", accept = "application/vnd.github+json", body } = {}) {
    const res = await fetch(this.url(path), {
      method,
      cache: "no-store",
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: accept,
        "X-GitHub-Api-Version": "2022-11-28",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 401) throw new AuthError("토큰이 올바르지 않거나 만료되었습니다.");
    if (res.status === 403) {
      const t = await res.text();
      throw new AuthError(/rate limit/i.test(t) ? "GitHub 요청 한도를 넘었습니다. 잠시 뒤 다시 시도하세요." : "이 토큰으로는 권한이 없습니다 (Contents 권한 확인).");
    }
    if (res.status === 409 || res.status === 422) throw new ConflictError("다른 곳에서 먼저 저장되었습니다.");
    return res;
  }

  /** 저장소에 접근할 수 있는지 (fine-grained 토큰은 권한이 없으면 404 를 준다). */
  async check() {
    const res = await fetch(`${API}/repos/${this.full}`, {
      cache: "no-store",
      headers: { Authorization: `Bearer ${this.token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
    });
    if (res.status === 401) throw new AuthError("토큰이 올바르지 않거나 만료되었습니다.");
    if (res.status === 404) throw new AuthError(`저장소 ${this.full} 를 찾을 수 없습니다. 이름과 토큰의 저장소 권한을 확인하세요.`);
    if (!res.ok) throw new Error(`저장소 확인 실패 (HTTP ${res.status})`);
    const j = await res.json();
    return { private: j.private, canPush: !!(j.permissions && j.permissions.push) };
  }

  /** 파일 내용을 JSON 으로. 없으면 null. */
  async readJson(path) {
    const res = await this.req(path, { accept: "application/vnd.github.raw+json" });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`${path} 읽기 실패 (HTTP ${res.status})`);
    return res.json();
  }

  /** {data, sha} — 쓰기 전에 sha 가 필요할 때. */
  async readJsonWithSha(path) {
    const res = await this.req(path);
    if (res.status === 404) return { data: null, sha: null };
    if (!res.ok) throw new Error(`${path} 읽기 실패 (HTTP ${res.status})`);
    const j = await res.json();
    return { data: JSON.parse(b64decode(j.content)), sha: j.sha };
  }

  async writeJson(path, data, sha, message) {
    const res = await this.req(path, {
      method: "PUT",
      body: { message, content: b64encode(JSON.stringify(data, null, 1) + "\n"), ...(sha ? { sha } : {}) },
    });
    if (!res.ok) throw new Error(`${path} 저장 실패 (HTTP ${res.status})`);
    return (await res.json()).content.sha;
  }

  /** 읽고-고치고-쓰기. 충돌하면 최신본으로 한 번 더 시도. */
  async update(path, fn, message) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const { data, sha } = await this.readJsonWithSha(path);
      const next = fn(data);
      try {
        await this.writeJson(path, next, sha, message);
        return next;
      } catch (e) {
        if (!(e instanceof ConflictError) || attempt) throw e;
      }
    }
  }
}
