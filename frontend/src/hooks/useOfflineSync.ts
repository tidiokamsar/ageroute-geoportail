import { useEffect, useState, useSyncExternalStore } from "react";
import { getSyncState, subscribeSync, syncPendingInspections } from "../lib/offlineSync";

export function useOfflineSync() {
  const state = useSyncExternalStore(subscribeSync, getSyncState, getSyncState);
  const [online, setOnline] = useState(navigator.onLine);

  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    return () => {
      window.removeEventListener("online", on);
      window.removeEventListener("offline", off);
    };
  }, []);

  return { ...state, online, syncNow: syncPendingInspections };
}
