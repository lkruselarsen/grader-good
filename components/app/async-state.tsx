import type { ReactNode } from "react";

export type AsyncStatus = "idle" | "loading" | "empty" | "error" | "success";

type AsyncStateProps = {
  status: AsyncStatus;
  loading?: ReactNode;
  empty?: ReactNode;
  error?: ReactNode;
  children: ReactNode;
};

export function AsyncState({
  status,
  loading,
  empty,
  error,
  children,
}: AsyncStateProps) {
  if (status === "loading" && loading) return <>{loading}</>;
  if (status === "empty" && empty) return <>{empty}</>;
  if (status === "error" && error) return <>{error}</>;
  return <>{children}</>;
}
