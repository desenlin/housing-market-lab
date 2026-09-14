"use client";

import { useEffect, useState } from "react";

export type HcdManifest = {
  release: string;
  created_at: string;
  latest_year: number;
  bundle_sha256: string;
  data_page: string;
  source: { last_modified: string };
};

export function useHcdManifest() {
  const [manifest, setManifest] = useState<HcdManifest | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    const base = `${process.env.NEXT_PUBLIC_BASE_PATH ?? ""}/data/hcd`;
    const get = async (url: string) => {
      const response = await fetch(url, { signal: controller.signal, cache: "no-store" });
      if (!response.ok) throw new Error("Unavailable");
      return response.json();
    };

    void (async () => {
      const pointer = await get(`${base}/latest.json`);
      setManifest(await get(`${base}/releases/${pointer.release}/manifest.json`));
    })().catch(() => {
      if (!controller.signal.aborted) setError(true);
    });

    return () => controller.abort();
  }, []);

  return { manifest, error };
}
