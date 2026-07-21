import { PIXBLOG_BASE_URL, PIXBLOG_API_TOKEN } from "./config.js";
import { log } from "./logger.js";

export interface PixBlogPost {
  id: number;
  title: string;
  slug: string;
  status: "draft" | "published";
  url: string;
  excerpt: string;
  featured_image_url: string | null;
  thumbnail_url: string | null;
  tags: { id: number; name: string; slug: string }[];
  view_count: number;
  click_count: string;
  created_at: string;
  updated_at: string;
  published_at: string | null;
}

interface PostsResponse {
  posts: PixBlogPost[];
  pagination: {
    page: number;
    per_page: number;
    total: string;
    total_pages: number;
  };
}

interface CreatePostParams {
  title: string;
  body: string;
  content_format: "markdown";
  tags: string[];
  status: "draft" | "published";
  memo?: string;
}

export interface PixBlogPostDetail extends PixBlogPost {
  content: string; // HTML body, available on GET /api/v1/posts/:id
}

interface UpdatePostParams {
  title?: string;
  body?: string;
  content_format?: "markdown" | "html";
  tags?: string[];
  status?: "draft" | "published";
  memo?: string;
}

async function apiRequest<T>(
  method: string,
  path: string,
  body?: unknown
): Promise<T> {
  const url = `${PIXBLOG_BASE_URL}${path}`;
  log("INFO", `PixBlog API: ${method} ${path}`);

  const headers: Record<string, string> = {
    Authorization: `Bearer ${PIXBLOG_API_TOKEN}`,
    "Content-Type": "application/json",
  };

  const res = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`PixBlog API error: ${res.status} ${res.statusText} - ${text}`);
  }

  return (await res.json()) as T;
}

export async function getPosts(): Promise<PixBlogPost[]> {
  const data = await apiRequest<PostsResponse>("GET", "/api/v1/posts");
  return data.posts;
}

export async function getPost(id: number): Promise<PixBlogPostDetail> {
  return apiRequest<PixBlogPostDetail>("GET", `/api/v1/posts/${id}`);
}

export async function createPost(params: CreatePostParams): Promise<PixBlogPost> {
  // PixBlog API returns the post object directly (not wrapped in { post: ... })
  return apiRequest<PixBlogPost>("POST", "/api/v1/posts", params);
}

export async function updatePost(
  id: number,
  params: UpdatePostParams
): Promise<PixBlogPost> {
  // PixBlog API returns the post object directly (not wrapped in { post: ... })
  return apiRequest<PixBlogPost>("PATCH", `/api/v1/posts/${id}`, params);
}

export interface UploadImageResult {
  url: string;
  filename: string;
}

export async function uploadImage(
  buffer: Buffer,
  filename: string,
  mimeType: string
): Promise<UploadImageResult> {
  const url = `${PIXBLOG_BASE_URL}/api/v1/images`;
  log("INFO", `PixBlog API: POST /api/v1/images (${filename}, ${buffer.length} bytes)`);

  const formData = new FormData();
  const blob = new Blob([new Uint8Array(buffer) as unknown as BlobPart], { type: mimeType });
  formData.append("file", blob, filename);

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${PIXBLOG_API_TOKEN}`,
    },
    body: formData,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`PixBlog image upload error: ${res.status} ${res.statusText} - ${text}`);
  }

  const data = (await res.json()) as { url: string; filename: string; size: number; content_type: string };
  return { url: data.url, filename: data.filename };
}

export async function deletePost(id: number): Promise<void> {
  const url = `${PIXBLOG_BASE_URL}/api/v1/posts/${id}`;
  log("INFO", `PixBlog API: DELETE /api/v1/posts/${id}`);

  const res = await fetch(url, {
    method: "DELETE",
    headers: {
      Authorization: `Bearer ${PIXBLOG_API_TOKEN}`,
    },
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`PixBlog API error: ${res.status} ${res.statusText} - ${text}`);
  }
}
