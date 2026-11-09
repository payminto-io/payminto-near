"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Download, LoaderCircle } from "lucide-react";
import { useApi } from "@/lib/session";
import { useMerchant } from "@/lib/gateway-queries";
import { ApiError } from "@/lib/http";
import { reportDatesProblem, reportFilename, reportWindow, saveFile, thisMonth, type ReportDates } from "@/lib/report";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { FormRow } from "./kit";

/**
 * "Download report" on Payments (docs/GATEWAY.md section 16): picks a date range, this month by default, and saves the
 * reconciliation report of the open business (or `merchantId`) as a CSV a spreadsheet opens.
 */
export function ReportButton({ merchantId }: { merchantId?: string | null }) {
  const api = useApi();
  const merchant = useMerchant(merchantId ?? undefined);
  const [open, setOpen] = useState(false);
  const [dates, setDates] = useState<ReportDates>(() => thisMonth());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const problem = reportDatesProblem(dates);

  const download = async () => {
    if (problem) return;
    setBusy(true);
    setError(null);
    try {
      const csv = await api.gateway.reconciliationCsv(reportWindow(dates), merchantId ?? undefined);
      saveFile(reportFilename(dates, merchant.data?.name), csv);
      toast.success("Report downloaded");
      setOpen(false);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "The report could not be made. Try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (o) {
          setDates(thisMonth());
          setError(null);
        }
      }}
    >
      <DialogTrigger asChild>
        <Button variant="outline">
          <Download /> Download report
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-[28rem]">
        <DialogHeader>
          <DialogTitle>Download report</DialogTitle>
          <DialogDescription>
            Every payment created between these dates, with fees, what you receive, refunds and the transaction on chain. Totals are on the last line.
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            void download();
          }}
        >
          <div className="grid grid-cols-2 gap-3">
            <FormRow id="report-from" label="From">
              <Input id="report-from" type="date" value={dates.from} max={dates.to || undefined} onChange={(e) => setDates((d) => ({ ...d, from: e.target.value }))} required />
            </FormRow>
            <FormRow id="report-to" label="To">
              <Input id="report-to" type="date" value={dates.to} min={dates.from || undefined} onChange={(e) => setDates((d) => ({ ...d, to: e.target.value }))} required />
            </FormRow>
          </div>
          <p className={problem || error ? "text-xs text-negative" : "text-xs text-muted-foreground"} role={problem || error ? "alert" : undefined}>
            {problem ?? error ?? "Both days are included. Dates are in your time zone."}
          </p>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy || problem !== null}>
              {busy ? <LoaderCircle className="animate-spin" /> : <Download />} Download CSV
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
