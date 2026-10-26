import { useEffect, useState, useSyncExternalStore } from "react";
import { abonnerCompte, etatCompte } from "../lib/compteCourant";
import { getSyncState, subscribeSync, syncPendingOfflineData } from "../lib/offlineSync";

export function useOfflineSync() {
  const state = useSyncExternalStore(subscribeSync, getSyncState, getSyncState);
  // La file est illisible tant que la session locale est verrouillee (ou qu aucun compte n est ouvert) : le badge le sait.
  const fileVerrouillee = useSyncExternalStore(abonnerCompte, () => etatCompte() !== "OUVERT", () => true);
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

  return { ...state, online, fileVerrouillee, syncNow: syncPendingOfflineData };
}
