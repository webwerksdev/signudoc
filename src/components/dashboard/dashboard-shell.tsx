"use client";

import { PlusIcon } from "lucide-react";
import { useState, type ChangeEvent } from "react";

import type { DashboardEnvelopeListItem } from "@/lib/envelopes";
import {
  DashboardDocumentsHeader,
  DashboardDocumentsPanel,
  dashboardStatusFilterMap,
  dashboardViewHref,
  type DashboardFilter,
  type DashboardPagination,
  type DashboardShellState,
  type DashboardView,
} from "@/components/dashboard/dashboard-documents-surface";
import { DocumentThumbnail } from "@/components/shared/document-thumbnail";
import { ShellButton } from "@/components/shared/form-shell";

type DashboardShellProps = {
  envelopes?: readonly DashboardEnvelopeListItem[];
  /** The search the page was loaded with, run on the server. */
  initialSearch?: string;
  initialState?: DashboardShellState;
  pagination?: DashboardPagination;
  /** Whose envelopes are listed, when there is a choice. */
  view?: DashboardView;
  /** The views this person can choose from. */
  views?: readonly DashboardView[];
};

export function DashboardShell({
  envelopes: providedEnvelopes,
  initialSearch = "",
  initialState = "default",
  pagination,
  view,
  views,
}: DashboardShellProps) {
  const [searchValue, setSearchValue] = useState(initialSearch);
  const [selectedFilter, setSelectedFilter] = useState<DashboardFilter>("All");

  const envelopes =
    initialState === "empty"
      ? ([] as readonly DashboardEnvelopeListItem[])
      : (providedEnvelopes ?? []);
  const normalizedSearchValue = searchValue.trim().toLowerCase();
  const filteredEnvelopes = envelopes.filter((envelope) => {
    const matchesFilter =
      selectedFilter === "All"
        ? true
        : envelope.status === dashboardStatusFilterMap[selectedFilter];
    const matchesSearch =
      normalizedSearchValue.length === 0 ||
      envelope.title.toLowerCase().includes(normalizedSearchValue) ||
      (envelope.senderLabel?.toLowerCase().includes(normalizedSearchValue) ??
        false) ||
      envelope.searchableEmails.some((email) =>
        email.toLowerCase().includes(normalizedSearchValue),
      );

    return matchesFilter && matchesSearch;
  });
  const isError = initialState === "error";

  function handleSearchChange(event: ChangeEvent<HTMLInputElement>) {
    setSearchValue(event.target.value);
  }

  function handleFilterChange(filter: DashboardFilter) {
    setSelectedFilter(filter);
  }

  function handleResetFilters() {
    if (initialSearch || pagination?.newerHref) {
      // The list itself was searched, or is a later page: load the start.
      window.location.assign(dashboardViewHref(view ?? "mine"));
      return;
    }

    setSearchValue("");
    setSelectedFilter("All");
  }

  function handleRetry() {
    window.location.reload();
  }

  return (
    <div className="space-y-5">
      <DashboardDocumentsHeader view={view} views={views} />

      {initialState === "empty" ? (
        view === "all" ? (
          <EmptyInstallState />
        ) : (
          <EmptyDashboardState />
        )
      ) : (
        <DashboardDocumentsPanel
          envelopes={envelopes}
          filteredEnvelopes={filteredEnvelopes}
          isError={isError}
          onFilterChange={handleFilterChange}
          onReset={handleResetFilters}
          onRetry={handleRetry}
          onSearchChange={handleSearchChange}
          pagination={pagination}
          searchValue={searchValue}
          view={view}
          selectedFilter={selectedFilter}
        />
      )}
    </div>
  );
}

function EmptyInstallState() {
  return (
    <section
      className="panel px-6 py-14 text-center sm:py-20"
      data-animate="enter"
      data-animate-delay="1"
    >
      <h2 className="text-2xl font-extrabold tracking-[-0.03em] text-(--fg)">
        No envelopes yet
      </h2>
      <p className="mt-2 text-[0.9375rem] leading-6 text-(--secondary)">
        Nobody in your organization has started an envelope.
      </p>
    </section>
  );
}

function EmptyDashboardState() {
  return (
    <section
      className="panel px-6 py-14 sm:py-20"
      data-animate="enter"
      data-animate-delay="1"
    >
      <div className="mx-auto flex max-w-md flex-col items-center gap-5 text-center">
        <span className="flex h-28 items-center justify-center">
          <DocumentThumbnail title="" />
        </span>
        <div className="space-y-2">
          <h2 className="text-2xl font-extrabold tracking-[-0.03em] text-(--fg)">
            No documents yet
          </h2>
          <p className="text-[0.9375rem] leading-6 text-(--secondary)">
            Upload a PDF and send it for signatures in minutes.
          </p>
        </div>
        <ShellButton href="/envelopes/new">
          <PlusIcon
            aria-hidden="true"
            className="size-[1.125rem]"
            strokeWidth={2.4}
          />
          New envelope
        </ShellButton>
      </div>
    </section>
  );
}
