import { useCallback, useRef, useState } from "react";
import {
  type Access,
  type BuyerData,
  type SellerData,
  request,
} from "./DashboardShared.js";

export type DashboardWorkspace = "buyer" | "seller";

export function useDashboardData(initialSellerLoading: boolean) {
  const [access, setAccess] = useState<Access | null>(null);
  const [buyer, setBuyer] = useState<BuyerData | null>(null);
  const [seller, setSeller] = useState<SellerData | null>(null);
  const [loading, setLoading] = useState<Record<DashboardWorkspace, boolean>>({
    buyer: true,
    seller: initialSellerLoading,
  });
  const [errors, setErrors] = useState<Record<DashboardWorkspace, string>>({
    buyer: "",
    seller: "",
  });
  const requestSequence = useRef<Record<DashboardWorkspace, number>>({
    buyer: 0,
    seller: 0,
  });
  const accessSequence = useRef(0);

  const load = useCallback(async (target: DashboardWorkspace) => {
    const sequence = ++requestSequence.current[target];
    const accessRequest = ++accessSequence.current;
    setLoading((current) => ({ ...current, [target]: true }));
    setErrors((current) => ({ ...current, [target]: "" }));
    try {
      const currentAccess = await request<Access>("/api/dashboard/access");
      if (accessRequest === accessSequence.current) setAccess(currentAccess);
      if (sequence !== requestSequence.current[target]) return;
      if (target === "buyer" && !currentAccess.buyer) return;
      if (target === "seller" && !currentAccess.seller) {
        setSeller(null);
        return;
      }
      if (target === "seller")
        setSeller(await request<SellerData>("/api/dashboard/seller"));
      else setBuyer(await request<BuyerData>("/api/dashboard/buyer"));
    } catch (error) {
      if (sequence === requestSequence.current[target])
        setErrors((current) => ({
          ...current,
          [target]:
            (error as Error).message || "Dashboard data could not be loaded.",
        }));
    } finally {
      if (sequence === requestSequence.current[target])
        setLoading((current) => ({ ...current, [target]: false }));
    }
  }, []);

  return { access, buyer, setBuyer, seller, loading, errors, load };
}
