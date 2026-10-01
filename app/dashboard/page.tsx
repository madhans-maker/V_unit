// src/app/dashboard/page.tsx
'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import {
  collection,
  query,
  orderBy,
  getDocs,
  deleteDoc,
  doc,
  limit,
  startAfter,
  getCountFromServer,
  QueryDocumentSnapshot,
  DocumentData,
  where,
  Timestamp,
} from 'firebase/firestore';
import { db } from '@/lib/firebase';
import { Package } from '@/types';
import { normalizePackageFromFirestore } from '@/lib/firestore-dates';
import { isPaymentPending } from '@/lib/package-status';
import { exportPackagesToExcel } from '@/lib/export-packages-excel';
import { useAuth } from '@/context/AuthContext';
import StatsCard from '@/components/StatsCard';
import SearchFilter, { SearchType } from '@/components/SearchFilter';
import PackageList from '@/components/PackageCard';
import AddPackageModal from '@/components/AddPackageModal';
import PackageTimelineDrawer from '@/components/PackageTimelineDrawer';
import {
  Clock,
  CheckCircle,
  XCircle,
  ShieldCheck,
  Plus,
  AlertCircle,
  FileSpreadsheet,
  Loader2,
} from 'lucide-react';

const ITEMS_PER_PAGE = 5;

type StatusFilter =
  | 'in_process'
  | 'payment_pending'
  | 'operation_completed'
  | 'operation_cancelled'
  | null;

const STATUS_FILTER_LABELS: Record<Exclude<StatusFilter, null>, string> = {
  in_process: 'In Process',
  payment_pending: 'Payment Pending',
  operation_completed: 'Operation Completed',
  operation_cancelled: 'Operation Cancelled',
};

export default function DashboardHome() {
  const { user } = useAuth();

  // Raw packages from Firestore (current page or search batch)
  const [packages, setPackages] = useState<Package[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [currentPage, setCurrentPage] = useState(1);
  const [totalCount, setTotalCount] = useState(0);

  const [showAddModal, setShowAddModal] = useState(false);
  const [editingPackage, setEditingPackage] = useState<Package | null>(null);
  const [showTimelineDrawer, setShowTimelineDrawer] = useState(false);
  const [selectedPackage, setSelectedPackage] = useState<Package | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [activeStatus, setActiveStatus] = useState<StatusFilter>(null);

  const pageCursors = useRef<Map<number, QueryDocumentSnapshot<DocumentData>>>(new Map());

  const [stats, setStats] = useState({
    inProcess: 0,
    paymentPending: 0,
    operationCompleted: 0,
    operationCancelled: 0,
  });

  const [searchTerm, setSearchTerm] = useState('');
  const [searchType, setSearchType] = useState<SearchType>('name');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [isExporting, setIsExporting] = useState(false);

  const isSearching = searchTerm.trim().length > 0;
  const usesClientSideStatusFilter = activeStatus === 'payment_pending';

  // ── Stats ──────────────────────────────────────────────────────────────────
  const fetchStats = useCallback(async () => {
    const ref = collection(db, 'packages');
    const [inProcess, operationCompleted, operationCancelled, billingDoneSnap] =
      await Promise.all([
        getCountFromServer(query(ref, where('status', '==', 'in_process'))),
        getCountFromServer(query(ref, where('status', '==', 'operation_completed'))),
        getCountFromServer(query(ref, where('status', '==', 'operation_cancelled'))),
        getDocs(query(ref, where('timeline.billing.completed', '==', true))),
      ]);

    const paymentPendingCount = billingDoneSnap.docs
      .map((d) =>
        normalizePackageFromFirestore(d.id, d.data() as Record<string, unknown>)
      )
      .filter(isPaymentPending).length;

    setStats({
      inProcess: inProcess.data().count,
      paymentPending: paymentPendingCount,
      operationCompleted: operationCompleted.data().count,
      operationCancelled: operationCancelled.data().count,
    });
  }, []);

  // ── Build server-side constraints (status + date only, no search field) ───
  const buildServerConstraints = useCallback(() => {
    const constraints: Parameters<typeof query>[1][] = [];

    // Payment pending is filtered client-side (timeline.payment.status) to avoid
    // needing a composite Firestore index with orderBy('createdAt').
    if (activeStatus && activeStatus !== 'payment_pending') {
      constraints.push(where('status', '==', activeStatus));
    }

    if (!isSearching) {
      // Date filters only apply when not doing a text search
      // (avoids conflict with orderBy field)
      if (fromDate) {
        const from = new Date(fromDate);
        from.setHours(0, 0, 0, 0);
        constraints.push(where('createdAt', '>=', Timestamp.fromDate(from)));
      }
      if (toDate) {
        const to = new Date(toDate);
        to.setHours(23, 59, 59, 999);
        constraints.push(where('createdAt', '<=', Timestamp.fromDate(to)));
      }
    }

    constraints.push(orderBy('createdAt', 'desc'));

    return constraints;
  }, [activeStatus, fromDate, toDate, isSearching]);

  // ── Client-side filters (payment pending + search) ─────────────────────────
  const applySearchFilter = useCallback(
    (items: Package[]): Package[] => {
      if (!isSearching) return items;
      const term = searchTerm.trim().toLowerCase();
      return items.filter((pkg) => {
        const fieldValue = (pkg[searchType as keyof Package] as string | undefined) ?? '';
        return fieldValue.toLowerCase().includes(term);
      });
    },
    [isSearching, searchTerm, searchType]
  );

  const applyClientFilters = useCallback(
    (items: Package[]): Package[] => {
      let filtered = items;
      if (activeStatus === 'payment_pending') {
        filtered = filtered.filter(isPaymentPending);
      }
      return applySearchFilter(filtered);
    },
    [activeStatus, applySearchFilter]
  );

  // ── SEARCH MODE: fetch all (status-filtered) docs, filter client-side ──────
  const fetchSearch = useCallback(async () => {
    setIsLoading(true);
    try {
      const packagesRef = collection(db, 'packages');
      const constraints = buildServerConstraints();

      // Fetch all docs matching server constraints (no limit)
      const snap = await getDocs(query(packagesRef, ...constraints));
      const all: Package[] = snap.docs.map((d) =>
        normalizePackageFromFirestore(d.id, d.data() as Record<string, unknown>)
      );

      const filtered = applyClientFilters(all);

      // Paginate in memory
      const total = filtered.length;
      setTotalCount(total);
      const start = (currentPage - 1) * ITEMS_PER_PAGE;
      setPackages(filtered.slice(start, start + ITEMS_PER_PAGE));
    } catch (error) {
      console.error('Error searching packages:', error);
    } finally {
      setIsLoading(false);
    }
  }, [buildServerConstraints, applyClientFilters, currentPage]);

  // ── NORMAL MODE: server-side pagination with cursors ──────────────────────
  const fetchPage = useCallback(
    async (page: number) => {
      setIsLoading(true);
      try {
        const packagesRef = collection(db, 'packages');
        const baseConstraints = buildServerConstraints();

        const countSnap = await getCountFromServer(query(packagesRef, ...baseConstraints));
        setTotalCount(countSnap.data().count);

        const pageConstraints = [...baseConstraints, limit(ITEMS_PER_PAGE)];
        if (page > 1) {
          const cursor = pageCursors.current.get(page);
          if (cursor) pageConstraints.push(startAfter(cursor));
        }

        const snap = await getDocs(query(packagesRef, ...pageConstraints));

        if (!snap.empty) {
          pageCursors.current.set(page + 1, snap.docs[snap.docs.length - 1]);
        }

        setPackages(
          snap.docs.map((d) =>
            normalizePackageFromFirestore(d.id, d.data() as Record<string, unknown>)
          )
        );
      } catch (error) {
        console.error('Error fetching packages:', error);
      } finally {
        setIsLoading(false);
      }
    },
    [buildServerConstraints]
  );

  // ── Reset cursors + page on filter changes ────────────────────────────────
  useEffect(() => {
    pageCursors.current.clear();
    setCurrentPage(1);
  }, [searchTerm, searchType, fromDate, toDate, activeStatus]);

  // ── Route to in-memory or server-side pagination ─────────────────────────
  useEffect(() => {
    if (isSearching || usesClientSideStatusFilter) {
      fetchSearch();
    } else {
      fetchPage(currentPage);
    }
  }, [currentPage, isSearching, usesClientSideStatusFilter, fetchSearch, fetchPage]);

  useEffect(() => {
    fetchStats();
  }, [fetchStats]);

  const refreshPackages = useCallback(() => {
    if (isSearching || activeStatus === 'payment_pending') {
      fetchSearch();
    } else {
      fetchPage(currentPage);
    }
  }, [isSearching, activeStatus, fetchSearch, fetchPage, currentPage]);

  const handleStatusCardClick = (status: StatusFilter) => {
    setActiveStatus((prev) => (prev === status ? null : status));
  };

  const handleEditPackage = (pkg: Package) => {
    setEditingPackage(pkg);
    setShowAddModal(true);
  };

  const handleDeletePackage = async (id: string) => {
    try {
      await deleteDoc(doc(db, 'packages', id));
      setDeleteId(null);
      pageCursors.current.clear();
      setCurrentPage(1);
      const reload =
        isSearching || activeStatus === 'payment_pending'
          ? fetchSearch()
          : fetchPage(1);
      await Promise.all([reload, fetchStats()]);
    } catch (error) {
      console.error('Error deleting package:', error);
    }
  };

  const clearFilters = () => {
    setSearchTerm('');
    setFromDate('');
    setToDate('');
    setActiveStatus(null);
  };

  const handleExportExcel = async () => {
    setIsExporting(true);
    try {
      const packagesRef = collection(db, 'packages');
      const constraints = buildServerConstraints();
      const snap = await getDocs(query(packagesRef, ...constraints));
      const all = snap.docs.map((d) =>
        normalizePackageFromFirestore(d.id, d.data() as Record<string, unknown>)
      );
      const filtered = applyClientFilters(all);

      if (filtered.length === 0) {
        alert('No packages to export for the current filters.');
        return;
      }

      exportPackagesToExcel(filtered, 'packages-report');
    } catch (error) {
      console.error('Error exporting packages:', error);
      alert('Failed to export Excel report. Please try again.');
    } finally {
      setIsExporting(false);
    }
  };

  const totalPages = Math.ceil(totalCount / ITEMS_PER_PAGE);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Dashboard</h1>
          <p className="text-gray-500 mt-1">Manage your packages and track status</p>
        </div>
        <div className="flex flex-col sm:flex-row gap-2 w-full sm:w-auto">
          <button
            onClick={handleExportExcel}
            disabled={isExporting || isLoading}
            className="btn-secondary flex items-center gap-2 w-full sm:w-auto justify-center"
          >
            {isExporting ? (
              <Loader2 className="w-5 h-5 animate-spin" />
            ) : (
              <FileSpreadsheet className="w-5 h-5" />
            )}
            {isExporting ? 'Exporting...' : 'Export Excel'}
          </button>
          <button
            onClick={() => {
              setEditingPackage(null);
              setShowAddModal(true);
            }}
            className="btn-primary flex items-center gap-2 w-full sm:w-auto justify-center"
          >
            <Plus className="w-5 h-5" />
            Add Package
          </button>
        </div>
      </div>

      {/* Delete Confirmation Modal */}
      {deleteId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/20 backdrop-blur-sm">
          <div className="bg-white rounded-xl p-6 max-w-md w-full mx-4 shadow-lg">
            <div className="flex items-center gap-3 mb-4">
              <AlertCircle className="w-6 h-6 text-red-500" />
              <h3 className="text-lg font-bold text-gray-900">Delete Package</h3>
            </div>
            <p className="text-gray-700 mb-6">
              This action cannot be undone. Are you sure you want to delete this package?
            </p>
            <div className="flex gap-3">
              <button onClick={() => setDeleteId(null)} className="flex-1 btn-secondary py-2">
                Cancel
              </button>
              <button
                onClick={() => handleDeletePackage(deleteId)}
                className="flex-1 btn-primary py-2 bg-red-600 hover:bg-red-700"
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Stats Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-4 gap-4">
        <StatsCard
          title="In Process"
          count={stats.inProcess}
          icon={Clock}
          color="yellow"
          isLoading={isLoading}
          onClick={() => handleStatusCardClick('in_process')}
          isActive={activeStatus === 'in_process'}
        />
        <StatsCard
          title="Payment Pending"
          count={stats.paymentPending}
          icon={ShieldCheck}
          color="blue"
          isLoading={isLoading}
          onClick={() => handleStatusCardClick('payment_pending')}
          isActive={activeStatus === 'payment_pending'}
        />
        <StatsCard
          title="Operation Completed"
          count={stats.operationCompleted}
          icon={CheckCircle}
          color="green"
          isLoading={isLoading}
          onClick={() => handleStatusCardClick('operation_completed')}
          isActive={activeStatus === 'operation_completed'}
        />
        <StatsCard
          title="Operation Cancelled"
          count={stats.operationCancelled}
          icon={XCircle}
          color="red"
          isLoading={isLoading}
          onClick={() => handleStatusCardClick('operation_cancelled')}
          isActive={activeStatus === 'operation_cancelled'}
        />
      </div>

      {/* Search and Filters */}
      <SearchFilter
        searchTerm={searchTerm}
        searchType={searchType}
        onSearchChange={setSearchTerm}
        onSearchTypeChange={setSearchType}
        fromDate={fromDate}
        toDate={toDate}
        onFromDateChange={setFromDate}
        onToDateChange={setToDate}
        onClearFilters={clearFilters}
      />

      {/* Results Count + Active Filter Badge */}
      {!isLoading && (
        <div className="flex items-center gap-3">
          <p className="text-sm text-gray-500">
            Showing {packages.length} of {totalCount} packages
          </p>
          {activeStatus && (
            <span className="inline-flex items-center gap-1 text-xs font-medium px-2 py-1 rounded-full bg-gray-100 text-gray-600">
              {STATUS_FILTER_LABELS[activeStatus]}
              <button
                onClick={() => setActiveStatus(null)}
                className="ml-1 hover:text-red-500 font-bold"
              >
                ×
              </button>
            </span>
          )}
        </div>
      )}

      {/* Package List */}
      <PackageList
        packages={packages}
        currentPage={currentPage}
        totalPages={totalPages}
        onPageChange={setCurrentPage}
        isLoading={isLoading}
        onEdit={handleEditPackage}
        onDelete={(id) => setDeleteId(id)}
        canDelete={user?.role === 'admin'}
        onTrack={(pkg) => {
          setSelectedPackage(pkg);
          setShowTimelineDrawer(true);
        }}
      />

      {/* Add Package Modal */}
      <AddPackageModal
        isOpen={showAddModal}
        onClose={() => setShowAddModal(false)}
        onSuccess={() => {
          pageCursors.current.clear();
          setCurrentPage(1);
          refreshPackages();
          fetchStats();
        }}
        editingPackage={editingPackage}
        currentUser={user}
      />

      {/* Package Timeline Drawer */}
      <PackageTimelineDrawer
        isOpen={showTimelineDrawer}
        onClose={() => {
          setShowTimelineDrawer(false);
          setSelectedPackage(null);
        }}
        package={selectedPackage}
        currentUser={user}
        onRefresh={() => {
          refreshPackages();
          fetchStats();
        }}
      />
    </div>
  );
}