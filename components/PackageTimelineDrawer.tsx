'use client';

import { useState, useEffect } from 'react';
import {
  doc,
  updateDoc,
  getDocs,
  collection,
  Timestamp,
  getDoc,
} from 'firebase/firestore';
import { db } from '@/lib/firebase';
import {
  formatDateForInput,
  normalizePackageFromFirestore,
  formatDisplayAmount,
  getPackageTotalAmount,
} from '@/lib/firestore-dates';
import { Package, Operation, AuthUser, PackageTimeline } from '@/types';
import SupportDocumentsList from '@/components/SupportDocumentsList';
import { buildWhatsAppAlertMessage } from '@/lib/whatsapp-alert';
import {
  X,
  CheckCircle,
  Circle,
  Lock,
  Bell,
  AlertCircle,
  Check,
  Trash2,
  Loader2,
} from 'lucide-react';

interface PackageTimelineDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  package: Package | null;
  currentUser: AuthUser | null;
  onRefresh: () => void;
}

const STAGES = [
  { id: 'packageCreated', label: 'Package Created' },
  { id: 'etd', label: 'ETD' },
  { id: 'eta', label: 'ETA' },
  { id: 'clearance', label: 'Clearance' },
  { id: 'cargoSegregation', label: 'Cargo Segregation' },
  { id: 'billing', label: 'Billing' },
  { id: 'payment', label: 'Payment' },
  { id: 'dispatch', label: 'Dispatch' },
];

const dateToTimestamp = (date: Date | undefined | null): Timestamp | undefined => {
  if (!date) return undefined;
  try {
    return Timestamp.fromDate(date instanceof Date ? date : new Date(date));
  } catch {
    return undefined;
  }
};

type StageSaveData = { canAdvance?: boolean };

const canAdvanceStage = (stageId: string, data: StageSaveData & Record<string, unknown>): boolean => {
  if (stageId === 'payment') return true;

  switch (stageId) {
    case 'packageCreated':
      // Allow advancing packageCreated stage with minimal data (name + vendor)
      return !!(data.name && (data.vendorId || data.vendorName));
    case 'etd':
      // Removed strict validation requiring all ETD dates so stage can advance without them
      return true;
    case 'eta':
      return !!(data.approxArrivalDate && data.arrivalDate);
    case 'clearance':
      return !!(data.status && data.clearanceDate);
    case 'cargoSegregation':
      return !!(data.status && data.segregationDate);
    case 'billing':
      return !!(data.status && data.billingDate);
    case 'dispatch':
      if (data.status === 'Dispatched') {
        return !!(
          data.status &&
          data.dispatchDate &&
          data.driverName &&
          data.driverPhone &&
          data.truckNo
        );
      }
      return !!(data.status && data.dispatchDate);
    default:
      return false;
  }
};

export default function PackageTimelineDrawer({
  isOpen,
  onClose,
  package: pkg,
  currentUser,
  onRefresh,
}: PackageTimelineDrawerProps) {
  const [activeStage, setActiveStage] = useState(0);
  const [loading, setLoading] = useState(false);
  const [operationsList, setOperationsList] = useState<Operation[]>([]);
  const [successMessage, setSuccessMessage] = useState('');
  const [errorMessage, setErrorMessage] = useState('');
  const [showCancelDialog, setShowCancelDialog] = useState(false);
  const [cancelReason, setCancelReason] = useState('');
  const [localPackage, setLocalPackage] = useState<Package | null>(pkg);
  const [initialLoadComplete, setInitialLoadComplete] = useState(false);

  const timeline = localPackage?.timeline || {};

  const isStageCompletedWithTimeline = (
    timelineObj: PackageTimeline,
    stageIndex: number
  ): boolean => {
    const stage = STAGES[stageIndex];
    if (stageIndex === 0) return timelineObj.packageCreated?.completed || false;
    if (stage.id === 'etd') return timelineObj.etd?.completed || timelineObj.etdEta?.completed || false;
    if (stage.id === 'eta') return timelineObj.eta?.completed || timelineObj.etdEta?.completed || false;
    if (stage.id === 'clearance') return timelineObj.clearance?.completed || false;
    if (stage.id === 'cargoSegregation')
      return timelineObj.cargoSegregation?.completed || false;
    if (stage.id === 'billing') return timelineObj.billing?.completed || false;
    if (stage.id === 'payment') return timelineObj.payment?.completed || false;
    if (stage.id === 'dispatch') return timelineObj.dispatch?.completed || false;
    return false;
  };

  const isStageCompleted = (stageIndex: number): boolean => {
    return isStageCompletedWithTimeline(timeline, stageIndex);
  };

  const isStageUnlocked = (stageIndex: number): boolean => {
    if (stageIndex === 0) return true;
    return isStageCompleted(stageIndex - 1);
  };

  const moveToNextStage = () => {
    const nextStage = activeStage + 1;
    if (nextStage < STAGES.length && isStageUnlocked(nextStage)) {
      setActiveStage(nextStage);
    }
  };

  const fetchUpdatedPackage = async (): Promise<Package | null> => {
    if (!pkg?.id) return null;
    try {
      const docRef = doc(db, 'packages', pkg.id);
      const docSnap = await getDoc(docRef);
      if (docSnap.exists()) {
        const updatedPkg = normalizePackageFromFirestore(
          docSnap.id,
          docSnap.data() as Record<string, unknown>
        );
        setLocalPackage(updatedPkg);
        return updatedPkg;
      }
    } catch (err) {
      console.error('Error fetching updated package:', err);
    }
    return null;
  };

  const fetchOperations = async () => {
    try {
      const opsRef = collection(db, 'operations');
      const snapshot = await getDocs(opsRef);
      const ops: Operation[] = [];
      snapshot.forEach((docSnap) => {
        const data = docSnap.data();
        ops.push({
          id: docSnap.id,
          type: data.type,
          status: Array.isArray(data.status) ? data.status : [],
          createdAt: data.createdAt?.toDate?.() || new Date(),
          updatedAt: data.updatedAt?.toDate?.() || new Date(),
        });
      });
      setOperationsList(ops);
    } catch (err) {
      console.error('Error fetching operations:', err);
    }
  };

  useEffect(() => {
    if (!isOpen) {
      setLocalPackage(null);
      setInitialLoadComplete(false);
      return;
    }

    let cancelled = false;

    const initializeDrawer = async () => {
      setInitialLoadComplete(false);

      const updatedPkg = await fetchUpdatedPackage();
      if (cancelled) return;

      const pkgToUse = updatedPkg || pkg;
      setLocalPackage(pkgToUse);
      await fetchOperations();
      if (cancelled) return;

      if (pkgToUse?.timeline) {
        const timelineToUse = pkgToUse.timeline;
        for (let i = 0; i < STAGES.length; i++) {
          if (!isStageCompletedWithTimeline(timelineToUse, i)) {
            setActiveStage(i);
            break;
          }
        }
      } else {
        setActiveStage(0);
      }

      setInitialLoadComplete(true);
    };

    initializeDrawer();

    return () => {
      cancelled = true;
    };
  }, [isOpen, pkg?.id]);

  const getStageIcon = (stageIndex: number) => {
    if (isStageCompleted(stageIndex))
      return <CheckCircle className="w-5 h-5 text-green-500" />;
    if (isStageUnlocked(stageIndex))
      return <Circle className="w-5 h-5 text-blue-500" />;
    return <Lock className="w-5 h-5 text-gray-300" />;
  };

  const handleStageClick = (index: number) => {
    if (isStageUnlocked(index)) {
      setActiveStage(index);
    }
  };

  const handleCancelPackage = async () => {
    if (!cancelReason.trim()) {
      setErrorMessage('Cancellation reason is required');
      return;
    }
    if (!localPackage?.id) return;

    try {
      setLoading(true);
      await updateDoc(doc(db, 'packages', localPackage.id), {
        status: 'operation_cancelled',
        cancelReason: cancelReason.trim(),
        cancelledAt: Timestamp.now(),
        updatedAt: Timestamp.now(),
        updatedBy: currentUser?.username,
      });
      setSuccessMessage('Package cancelled successfully');
      setCancelReason('');
      setShowCancelDialog(false);
      setTimeout(() => {
        setSuccessMessage('');
        onClose();
      }, 2000);
      onRefresh();
      await fetchUpdatedPackage();
    } catch (err) {
      console.error('Error cancelling package:', err);
      setErrorMessage('Failed to cancel package');
    } finally {
      setLoading(false);
    }
  };

  if (!isOpen || !localPackage) return null;

  return (
    <div className="fixed inset-0 z-50 flex justify-end pointer-events-none">
      <div className="absolute inset-0 pointer-events-auto" onClick={onClose} />

      <div className="relative w-full max-w-[600px] h-full bg-white shadow-2xl overflow-hidden flex flex-col pointer-events-auto">
        {/* Header */}
        <div className="flex items-center justify-between p-6 border-b border-gray-200 bg-gradient-to-r from-blue-50 to-indigo-50">
          <div>
            <h2 className="text-xl font-bold text-gray-900">{localPackage.name}</h2>
            <p className="text-sm text-gray-500 mt-1">
              Tracking #{localPackage.id.slice(0, 8).toUpperCase()}
            </p>
          </div>
          <button
            onClick={onClose}
            className="p-2 hover:bg-white rounded-lg transition-colors"
          >
            <X className="w-5 h-5 text-gray-600" />
          </button>
        </div>

        {successMessage && (
          <div className="px-6 py-3 bg-green-50 border-b border-green-200 text-green-700 text-sm flex items-center gap-2">
            <Check className="w-4 h-4" />
            {successMessage}
          </div>
        )}

        {errorMessage && (
          <div className="px-6 py-3 bg-red-50 border-b border-red-200 text-red-700 text-sm flex items-center gap-2">
            <AlertCircle className="w-4 h-4" />
            {errorMessage}
          </div>
        )}

        <div className="flex flex-1 overflow-hidden">
          {/* Timeline Sidebar */}
          <div className="w-48 border-r border-gray-200 bg-gray-50 overflow-y-auto">
            {STAGES.map((stage, index) => (
              <button
                key={stage.id}
                onClick={() => handleStageClick(index)}
                disabled={!isStageUnlocked(index)}
                className={`w-full px-4 py-4 border-l-4 transition-colors text-left ${
                  activeStage === index
                    ? 'border-blue-500 bg-blue-50'
                    : 'border-transparent hover:bg-gray-100'
                } ${!isStageUnlocked(index) ? 'cursor-not-allowed opacity-50' : 'cursor-pointer'}`}
              >
                <div className="flex items-center gap-2 mb-1">
                  {getStageIcon(index)}
                  <span className="text-sm font-medium text-gray-900">
                    {stage.label}
                  </span>
                </div>
                <p className="text-xs text-gray-500 ml-7">
                  {isStageCompleted(index) ? 'Completed' : 'Pending'}
                </p>
              </button>
            ))}
          </div>

          {/* Stage Content */}
          <div className="flex-1 overflow-y-auto">
            <div className="p-6">
              {!initialLoadComplete ? (
                <div className="flex flex-col items-center justify-center py-16 gap-3">
                  <Loader2 className="w-8 h-8 animate-spin text-blue-600" />
                  <p className="text-sm text-gray-500">Loading package data...</p>
                </div>
              ) : activeStage === 0 ? (
                <StagePackageCreated
                  key={`created-${localPackage.id}-${localPackage.updatedAt.getTime()}`}
                  pkg={localPackage}
                  timeline={timeline}
                  currentUser={currentUser}
                  onSave={async (data) => {
                    try {
                      setLoading(true);
                      const canAdvance = canAdvanceStage('packageCreated', data);
                      await updateDoc(doc(db, 'packages', localPackage.id), {
                        name: data.name,
                        description: data.description,
                        packageType: data.packageType,
                        packageCount: data.packageCount,
                        weight: data.weight,
                        cbm: data.cbm,
                        vendorId: data.vendorId,
                        vendorName: data.vendorName,
                        vendorCode: data.vendorCode,
                        'timeline.packageCreated': {
                          completed: canAdvance,
                          savedAt: Timestamp.now(),
                          savedBy: currentUser?.username,
                        },
                        updatedAt: Timestamp.now(),
                        updatedBy: currentUser?.username,
                      });
                      setSuccessMessage(
                        canAdvance
                          ? 'Package details saved successfully'
                          : 'Progress saved — fill all required fields to unlock the next stage'
                      );
                      setTimeout(() => setSuccessMessage(''), 3000);
                      onRefresh();
                      await fetchUpdatedPackage();
                      if (canAdvance) moveToNextStage();
                    } catch (err) {
                      console.error('Error saving package:', err);
                      setErrorMessage('Failed to save package details');
                    } finally {
                      setLoading(false);
                    }
                  }}
                  isLoading={loading}
                />
              ) : activeStage === 1 ? (
                <StageETD
                  key={`etd-${localPackage.id}-${localPackage.updatedAt.getTime()}`}
                  pkg={localPackage}
                  timeline={timeline}
                  currentUser={currentUser}
                  onSave={async (data) => {
                    try {
                      setLoading(true);
                      const canAdvance = canAdvanceStage('etd', data);
                      const etdUpdate: any = {
                        note: data.note || '',
                        completed: canAdvance,
                        savedAt: Timestamp.now(),
                        savedBy: currentUser?.username,
                      };
                      if (data.estimatedDeparture) etdUpdate.estimatedDeparture = dateToTimestamp(data.estimatedDeparture);
                      if (data.shippedOnboardDate) etdUpdate.shippedOnboardDate = dateToTimestamp(data.shippedOnboardDate);
                      if (data.sailedDate) etdUpdate.sailedDate = dateToTimestamp(data.sailedDate);
                      
                      await updateDoc(doc(db, 'packages', localPackage.id), {
                        'timeline.etd': etdUpdate,
                        updatedAt: Timestamp.now(),
                        updatedBy: currentUser?.username,
                      });
                      setSuccessMessage(
                        canAdvance
                          ? 'ETD saved successfully'
                          : 'Progress saved — fill all required fields to unlock the next stage'
                      );
                      setTimeout(() => setSuccessMessage(''), 3000);
                      onRefresh();
                      await fetchUpdatedPackage();
                      if (canAdvance) moveToNextStage();
                    } catch (err) {
                      console.error('Error saving ETD:', err);
                      setErrorMessage('Failed to save ETD');
                    } finally {
                      setLoading(false);
                    }
                  }}
                  isLoading={loading}
                />
              ) : activeStage === 2 ? (
                <StageETA
                  key={`eta-${localPackage.id}-${localPackage.updatedAt.getTime()}`}
                  pkg={localPackage}
                  timeline={timeline}
                  currentUser={currentUser}
                  onSave={async (data) => {
                    try {
                      setLoading(true);
                      const canAdvance = canAdvanceStage('eta', data);
                      const etaUpdate: any = {
                        note: data.note || '',
                        completed: canAdvance,
                        savedAt: Timestamp.now(),
                        savedBy: currentUser?.username,
                      };
                      if (data.approxArrivalDate) etaUpdate.approxArrivalDate = dateToTimestamp(data.approxArrivalDate);
                      if (data.arrivalDate) etaUpdate.arrivalDate = dateToTimestamp(data.arrivalDate);
                      if (data.status) etaUpdate.status = data.status;
                      
                      await updateDoc(doc(db, 'packages', localPackage.id), {
                        'timeline.eta': etaUpdate,
                        updatedAt: Timestamp.now(),
                        updatedBy: currentUser?.username,
                      });
                      setSuccessMessage(
                        canAdvance
                          ? 'ETA saved successfully'
                          : 'Progress saved — fill all required fields to unlock the next stage'
                      );
                      setTimeout(() => setSuccessMessage(''), 3000);
                      onRefresh();
                      await fetchUpdatedPackage();
                      if (canAdvance) moveToNextStage();
                    } catch (err) {
                      console.error('Error saving ETA:', err);
                      setErrorMessage('Failed to save ETA');
                    } finally {
                      setLoading(false);
                    }
                  }}
                  isLoading={loading}
                />
              ) : activeStage === 3 ? (
                <StageClearance
                  key={`clearance-${localPackage.id}-${localPackage.updatedAt.getTime()}`}
                  pkg={localPackage}
                  timeline={timeline}
                  currentUser={currentUser}
                  operations={operationsList}
                  onSave={async (data) => {
                    try {
                      setLoading(true);
                      const canAdvance = canAdvanceStage('clearance', data);
                      const clearanceUpdate: any = {
                        status: data.status || '',
                        note: data.note || '',
                        completed: canAdvance,
                        savedAt: Timestamp.now(),
                        savedBy: currentUser?.username,
                      };
                      if (data.clearanceDate) clearanceUpdate.clearanceDate = dateToTimestamp(data.clearanceDate);
                      
                      await updateDoc(doc(db, 'packages', localPackage.id), {
                        'timeline.clearance': clearanceUpdate,
                        updatedAt: Timestamp.now(),
                        updatedBy: currentUser?.username,
                      });
                      setSuccessMessage(
                        canAdvance
                          ? 'Clearance saved successfully'
                          : 'Progress saved — fill all required fields to unlock the next stage'
                      );
                      setTimeout(() => setSuccessMessage(''), 3000);
                      onRefresh();
                      await fetchUpdatedPackage();
                      if (canAdvance) moveToNextStage();
                    } catch (err) {
                      console.error('Error saving clearance:', err);
                      setErrorMessage('Failed to save clearance');
                    } finally {
                      setLoading(false);
                    }
                  }}
                  isLoading={loading}
                />
              ) : activeStage === 4 ? (
                <StageCargoSegregation
                  key={`cargo-${localPackage.id}-${localPackage.updatedAt.getTime()}`}
                  pkg={localPackage}
                  timeline={timeline}
                  currentUser={currentUser}
                  operations={operationsList}
                  onSave={async (data) => {
                    try {
                      setLoading(true);
                      const canAdvance = canAdvanceStage('cargoSegregation', data);
                      const cargoUpdate: any = {
                        status: data.status || '',
                        note: data.note || '',
                        completed: canAdvance,
                        savedAt: Timestamp.now(),
                        savedBy: currentUser?.username,
                      };
                      if (data.segregationDate) cargoUpdate.segregationDate = dateToTimestamp(data.segregationDate);
                      
                      await updateDoc(doc(db, 'packages', localPackage.id), {
                        'timeline.cargoSegregation': cargoUpdate,
                        updatedAt: Timestamp.now(),
                        updatedBy: currentUser?.username,
                      });
                      setSuccessMessage(
                        canAdvance
                          ? 'Cargo Segregation saved successfully'
                          : 'Progress saved — fill all required fields to unlock the next stage'
                      );
                      setTimeout(() => setSuccessMessage(''), 3000);
                      onRefresh();
                      await fetchUpdatedPackage();
                      if (canAdvance) moveToNextStage();
                    } catch (err) {
                      console.error('Error saving cargo segregation:', err);
                      setErrorMessage('Failed to save cargo segregation');
                    } finally {
                      setLoading(false);
                    }
                  }}
                  isLoading={loading}
                />
              ) : activeStage === 5 ? (
                <StageBilling
                  key={`billing-${localPackage.id}-${localPackage.updatedAt.getTime()}`}
                  pkg={localPackage}
                  timeline={timeline}
                  currentUser={currentUser}
                  operations={operationsList}
                  onSave={async (data) => {
                    try {
                      setLoading(true);
                      const canAdvance = canAdvanceStage('billing', data);
                      const billingUpdate: any = {
                        status: data.status || '',
                        note: data.note || '',
                        completed: canAdvance,
                        savedAt: Timestamp.now(),
                        savedBy: currentUser?.username,
                      };
                      if (data.billingDate) billingUpdate.billingDate = dateToTimestamp(data.billingDate);
                      
                      await updateDoc(doc(db, 'packages', localPackage.id), {
                        'timeline.billing': billingUpdate,
                        updatedAt: Timestamp.now(),
                        updatedBy: currentUser?.username,
                      });
                      setSuccessMessage(
                        canAdvance
                          ? 'Billing saved successfully'
                          : 'Progress saved — fill all required fields to unlock the next stage'
                      );
                      setTimeout(() => setSuccessMessage(''), 3000);
                      onRefresh();
                      await fetchUpdatedPackage();
                      if (canAdvance) moveToNextStage();
                    } catch (err) {
                      console.error('Error saving billing:', err);
                      setErrorMessage('Failed to save billing');
                    } finally {
                      setLoading(false);
                    }
                  }}
                  isLoading={loading}
                />
              ) : activeStage === 6 ? (
                <StagePayment
                  key={`payment-${localPackage.id}-${localPackage.updatedAt.getTime()}`}
                  pkg={localPackage}
                  timeline={timeline}
                  currentUser={currentUser}
                  operations={operationsList}
                  onSave={async (data) => {
                    try {
                      setLoading(true);
                      const paymentUpdate: any = {
                        status: data.status || '',
                        note: data.note || '',
                        completed: true,
                        savedAt: Timestamp.now(),
                        savedBy: currentUser?.username,
                      };
                      if (data.paymentDate) paymentUpdate.paymentDate = dateToTimestamp(data.paymentDate);
                      
                      await updateDoc(doc(db, 'packages', localPackage.id), {
                        'timeline.payment': paymentUpdate,
                        updatedAt: Timestamp.now(),
                        updatedBy: currentUser?.username,
                      });
                      setSuccessMessage('Payment saved successfully');
                      setTimeout(() => setSuccessMessage(''), 3000);
                      onRefresh();
                      await fetchUpdatedPackage();
                      moveToNextStage();
                    } catch (err) {
                      console.error('Error saving payment:', err);
                      setErrorMessage('Failed to save payment');
                    } finally {
                      setLoading(false);
                    }
                  }}
                  isLoading={loading}
                />
              ) : activeStage === 7 ? (
                <StageDispatch
                  key={`dispatch-${localPackage.id}-${localPackage.updatedAt.getTime()}`}
                  pkg={localPackage}
                  timeline={timeline}
                  operations={operationsList}
                  onSave={async (data) => {
                    try {
                      setLoading(true);
                      const canAdvance = canAdvanceStage('dispatch', data);
                      const dispatchUpdate: any = {
                        status: data.status || '',
                        driverName: data.driverName || '',
                        driverPhone: data.driverPhone || '',
                        note: data.note || '',
                        completed: canAdvance,
                        savedAt: Timestamp.now(),
                        savedBy: currentUser?.username,
                        truckNo: data.truckNo || '',
                      };
                      if (data.dispatchDate) dispatchUpdate.dispatchDate = dateToTimestamp(data.dispatchDate);
                      
                      await updateDoc(doc(db, 'packages', localPackage.id), {
                        'timeline.dispatch': dispatchUpdate,
                        updatedAt: Timestamp.now(),
                        updatedBy: currentUser?.username,
                      });
                      setSuccessMessage(
                        canAdvance
                          ? 'Dispatch saved successfully'
                          : 'Progress saved — fill all required fields to unlock the next stage'
                      );
                      setTimeout(() => setSuccessMessage(''), 3000);
                      onRefresh();
                      await fetchUpdatedPackage();
                      if (canAdvance) moveToNextStage();
                    } catch (err) {
                      console.error('Error saving dispatch:', err);
                      setErrorMessage('Failed to save dispatch');
                    } finally {
                      setLoading(false);
                    }
                  }}
                  isLoading={loading}
                />
              ) : null}
            </div>
          </div>
        </div>

        {/* Footer — cancel available anytime */}
        <div className="border-t border-gray-200 p-4 bg-gray-50">
          <button
            onClick={() => setShowCancelDialog(true)}
            disabled={loading || localPackage.status === 'operation_cancelled'}
            className="w-full btn-secondary py-2.5 flex items-center justify-center gap-2 text-red-600 border-red-200 hover:bg-red-50 disabled:opacity-50"
          >
            <Trash2 className="w-4 h-4" />
            Cancel Package
          </button>
        </div>

        {/* Cancel Dialog */}
        {showCancelDialog && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-50">
            <div className="bg-white rounded-xl p-6 max-w-md w-full mx-4 shadow-lg">
              <div className="flex items-center gap-3 mb-4">
                <AlertCircle className="w-6 h-6 text-red-500" />
                <h3 className="text-lg font-bold text-gray-900">
                  Cancel Package
                </h3>
              </div>
              <p className="text-gray-700 mb-4">
                This action cannot be undone. Please provide a reason for cancellation.
              </p>
              <textarea
                value={cancelReason}
                onChange={(e) => setCancelReason(e.target.value)}
                placeholder="Enter cancellation reason..."
                className="input-field w-full mb-4"
                rows={3}
              />
              <div className="flex gap-3">
                <button
                  onClick={() => {
                    setShowCancelDialog(false);
                    setCancelReason('');
                  }}
                  className="flex-1 btn-secondary py-2"
                >
                  Keep Package
                </button>
                <button
                  onClick={handleCancelPackage}
                  disabled={loading}
                  className="flex-1 btn-primary py-2 bg-red-600 hover:bg-red-700"
                >
                  Confirm Cancel
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// Stage Components (simplified for brevity - you'll expand each)

function StagePackageCreated({
  pkg,
  timeline,
  currentUser,
  onSave,
  isLoading,
}: {
  pkg: Package;
  timeline: any;
  currentUser: AuthUser | null;
  onSave: (data: any) => Promise<void>;
  isLoading: boolean;
}) {
  const [formData, setFormData] = useState({
    name: pkg.name || '',
    description: pkg.description || '',
    packageType: pkg.packageType || '',
    packageCount: pkg.packageCount || '',
    weightType: pkg.weightType || 'KG',
    weight: pkg.weight || '',
    cbm: pkg.cbm || '',
    vendorId: pkg.vendorId || '',
    vendorName: pkg.vendorName || '',
    vendorCode: pkg.vendorCode || '',
    vendorDeliveryAddress: pkg.vendorDeliveryAddress || '',
    vendorBillingAddress: pkg.vendorBillingAddress || '',
  });

  useEffect(() => {
    setFormData({
      name: pkg.name || '',
      description: pkg.description || '',
      packageType: pkg.packageType || '',
      packageCount: pkg.packageCount || '',
      weightType: pkg.weightType || 'KG',
      weight: pkg.weight || '',
      cbm: pkg.cbm || '',
      vendorId: pkg.vendorId || '',
      vendorName: pkg.vendorName || '',
      vendorCode: pkg.vendorCode || '',
      vendorDeliveryAddress: pkg.vendorDeliveryAddress || '',
      vendorBillingAddress: pkg.vendorBillingAddress || '',
    });
  }, [pkg]);

  const packageTypeOptions = [
    { value: 'Cartons', label: 'Cartons' },
    { value: 'Pallets', label: 'Pallets' },
    { value: 'Rolls', label: 'Rolls' },
    { value: 'Drums', label: 'Drums' },
  ];

  return (
    <div className="space-y-6">
      <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
        <p className="text-sm text-blue-800">
          <strong>Stage 1:</strong> Review and edit package details. Once saved,
          this stage will be completed and Stage 2 (ETD/ETA) will be unlocked.
        </p>
      </div>

      <div className="space-y-4">
        <p className="font-medium text-gray-900">Read-Only Information</p>
        <div className="grid grid-cols-1 gap-4">
          <div className="bg-gray-50 border border-gray-200 rounded-xl p-4 space-y-2">
            <p className="text-sm font-semibold text-gray-900">Vendor details</p>
            <p className="text-sm text-gray-700">
              <strong>Vendor:</strong> {formData.vendorName || formData.vendorCode || '-'}
            </p>
            <p className="text-sm text-gray-700">
              <strong>Delivery Address:</strong> {formData.vendorDeliveryAddress || '-'}
            </p>
            <p className="text-sm text-gray-700">
              <strong>Billing Address:</strong> {formData.vendorBillingAddress || '-'}
            </p>
          </div>
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1.5">
            Package Name
          </label>
          <input
            type="text"
            value={formData.name}
            disabled
            className="input-field bg-gray-100"
            placeholder="Package name"
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1.5">
            Description
          </label>
          <textarea
            value={formData.description}
            disabled
            className="input-field resize-none bg-gray-100"
            rows={3}
            placeholder="Package description"
          />
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 sm:gap-6">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">
              Package Type
            </label>
            <input
              type="text"
              value={formData.packageType}
              disabled
              className="input-field bg-gray-100"
              placeholder="Package Type"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">
              Quantity
            </label>
            <input
              type="number"
              value={formData.packageCount}
              disabled
              className="input-field bg-gray-100"
              placeholder="Qty"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">
              Weight Type
            </label>
            <input
              type="text"
              value={formData.weightType}
              disabled
              className="input-field bg-gray-100"
              placeholder="Weight Type"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">
              Weight
            </label>
            <input
              type="number"
              step="0.01"
              value={formData.weight}
              disabled
              className="input-field bg-gray-100"
              placeholder="Weight"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">
              CBM
            </label>
            <input
              type="number"
              step="0.01"
              value={formData.cbm}
              disabled
              className="input-field bg-gray-100"
              placeholder="CBM"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">
              Amount Per CBM
            </label>
            <input
              type="text"
              readOnly
              value={formatDisplayAmount(pkg.amountPerCbm)}
              className="input-field bg-gray-100 text-gray-700 cursor-not-allowed"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">
              Total Amount
            </label>
            <input
              type="text"
              readOnly
              value={formatDisplayAmount(getPackageTotalAmount(pkg))}
              className="input-field bg-gray-100 text-gray-700 cursor-not-allowed"
            />
          </div>
        </div>

        <div className="bg-gray-50 rounded-lg p-4 space-y-2 text-sm">
          <p className="text-gray-600">
            <strong>Created:</strong> {pkg.createdAt?.toLocaleDateString()} by{' '}
            {pkg.createdBy || 'Unknown'}
          </p>
        </div>

        <SupportDocumentsList documents={pkg.supportDocuments} />

        <button
          onClick={() => onSave(formData)}
          disabled={isLoading}
          className="w-full btn-primary py-2.5 flex items-center justify-center gap-2"
        >
          {isLoading ? (
            <>
              <Loader2 className="w-4 h-4 animate-spin" />
              Saving...
            </>
          ) : (
            <>
              <Check className="w-4 h-4" />
              Save
            </>
          )}
        </button>
      </div>

      {timeline.packageCreated?.completed && (
        <AlertCustomerButton
          pkg={pkg}
          stageKey="packageCreated"
          stageData={timeline.packageCreated}
        />
      )}
    </div>
  );
}

function StageETD({
  pkg,
  timeline,
  currentUser,
  onSave,
  isLoading,
}: {
  pkg: Package;
  timeline: any;
  currentUser: AuthUser | null;
  onSave: (data: any) => Promise<void>;
  isLoading: boolean;
}) {
  const etdData = timeline.etd || timeline.etdEta || {};

  const [formData, setFormData] = useState({
    estimatedDeparture: formatDateForInput(etdData.estimatedDeparture),
    shippedOnboardDate: formatDateForInput(etdData.shippedOnboardDate),
    sailedDate: formatDateForInput(etdData.sailedDate),
    note: etdData.note || '',
  });

  useEffect(() => {
    const etd = timeline.etd || timeline.etdEta || {};
    setFormData({
      estimatedDeparture: formatDateForInput(etd.estimatedDeparture),
      shippedOnboardDate: formatDateForInput(etd.shippedOnboardDate),
      sailedDate: formatDateForInput(etd.sailedDate),
      note: etd.note || '',
    });
  }, [timeline]);

  const handleSave = async () => {
    await onSave({
      estimatedDeparture: formData.estimatedDeparture
        ? new Date(formData.estimatedDeparture)
        : undefined,
      shippedOnboardDate: formData.shippedOnboardDate
        ? new Date(formData.shippedOnboardDate)
        : undefined,
      sailedDate: formData.sailedDate
        ? new Date(formData.sailedDate)
        : undefined,
      note: formData.note,
    });
  };

  const isComplete =
    !!formData.estimatedDeparture &&
    !!formData.shippedOnboardDate &&
    !!formData.sailedDate;

  return (
    <div className="space-y-6">
      <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
        <p className="text-sm text-blue-800">
          <strong>Stage 2 (ETD):</strong> Enter ETD dates. Fields unlock sequentially
          - fill in each field before moving to the next.
        </p>
      </div>

      <div className="space-y-4">
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1.5">
            Estimated Time of Departure *
          </label>
          <input
            type="date"
            value={formData.estimatedDeparture}
            onChange={(e) =>
              setFormData({ ...formData, estimatedDeparture: e.target.value })
            }
            className="input-field"
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1.5">
            Shipped Onboard Date *
            {!formData.estimatedDeparture && (
              <span className="text-gray-400 ml-1">(fill above first)</span>
            )}
          </label>
          <input
            type="date"
            value={formData.shippedOnboardDate}
            onChange={(e) =>
              setFormData({
                ...formData,
                shippedOnboardDate: e.target.value,
              })
            }
            className="input-field"
            disabled={!formData.estimatedDeparture}
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1.5">
            Sailed Date *
            {!formData.shippedOnboardDate && (
              <span className="text-gray-400 ml-1">(fill above first)</span>
            )}
          </label>
          <input
            type="date"
            value={formData.sailedDate}
            onChange={(e) =>
              setFormData({ ...formData, sailedDate: e.target.value })
            }
            className="input-field"
            disabled={!formData.shippedOnboardDate}
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1.5">
            Common Note
          </label>
          <textarea
            value={formData.note}
            onChange={(e) => setFormData({ ...formData, note: e.target.value })}
            className="input-field resize-none"
            rows={3}
            placeholder="Add any notes about this stage..."
          />
        </div>

        {!isComplete && (
          <p className="text-xs text-amber-600">
            Fill all date fields to unlock the next stage. Notes are optional.
          </p>
        )}

        <button
          onClick={handleSave}
          disabled={isLoading}
          className="w-full btn-primary py-2.5 flex items-center justify-center gap-2"
        >
          {isLoading ? (
            <>
              <Loader2 className="w-4 h-4 animate-spin" />
              Saving...
            </>
          ) : (
            <>
              <Check className="w-4 h-4" />
              {isComplete ? 'Save & Continue' : 'Save Progress'}
            </>
          )}
        </button>
      </div>

      {(timeline.etd?.completed || timeline.etdEta?.completed) && (
        <AlertCustomerButton
          pkg={pkg}
          stageKey="etd"
          stageData={timeline.etd || timeline.etdEta}
        />
      )}
    </div>
  );
}

function StageETA({
  pkg,
  timeline,
  currentUser,
  onSave,
  isLoading,
}: {
  pkg: Package;
  timeline: any;
  currentUser: AuthUser | null;
  onSave: (data: any) => Promise<void>;
  isLoading: boolean;
}) {
  const etaData = timeline.eta || timeline.etdEta || {};

  const [formData, setFormData] = useState({
    approxArrivalDate: formatDateForInput(etaData.approxArrivalDate || etaData.expectedArrival),
    arrivalDate: formatDateForInput(etaData.arrivalDate),
    note: etaData.note || '',
  });

  useEffect(() => {
    const eta = timeline.eta || timeline.etdEta || {};
    setFormData({
      approxArrivalDate: formatDateForInput(eta.approxArrivalDate || eta.expectedArrival),
      arrivalDate: formatDateForInput(eta.arrivalDate),
      note: eta.note || '',
    });
  }, [timeline]);

  const handleSave = async () => {
    await onSave({
      approxArrivalDate: formData.approxArrivalDate
        ? new Date(formData.approxArrivalDate)
        : undefined,
      arrivalDate: formData.arrivalDate
        ? new Date(formData.arrivalDate)
        : undefined,
      status: formData.approxArrivalDate ? 'In Transit' : '',
      note: formData.note,
    });
  };

  const hasApproxDate = !!formData.approxArrivalDate;
  const isComplete = !!formData.approxArrivalDate && !!formData.arrivalDate;

  return (
    <div className="space-y-6">
      <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
        <p className="text-sm text-blue-800">
          <strong>Stage 3 (ETA):</strong> Enter Approximate Date of Arrival. Arrival Date will be enabled once Approximate Date of Arrival is filled.
        </p>
      </div>

      <div className="space-y-4">
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1.5">
            Approx Date of Arrival *
          </label>
          <input
            type="date"
            value={formData.approxArrivalDate}
            onChange={(e) =>
              setFormData({ ...formData, approxArrivalDate: e.target.value })
            }
            className="input-field"
          />
        </div>

        {hasApproxDate && (
          <div className="flex items-center gap-2">
            <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold bg-green-100 text-green-800 border border-green-200 animate-pulse">
              In Transit
            </span>
          </div>
        )}

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1.5">
            Arrival Date *
            {!hasApproxDate && (
              <span className="text-gray-400 ml-1">(fill App Date of Arrival first)</span>
            )}
          </label>
          <input
            type="date"
            value={formData.arrivalDate}
            onChange={(e) =>
              setFormData({ ...formData, arrivalDate: e.target.value })
            }
            className="input-field"
            disabled={!hasApproxDate}
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1.5">
            Common Note
          </label>
          <textarea
            value={formData.note}
            onChange={(e) => setFormData({ ...formData, note: e.target.value })}
            className="input-field resize-none"
            rows={3}
            placeholder="Add any notes about this stage..."
          />
        </div>

        {!isComplete && (
          <p className="text-xs text-amber-600">
            Fill all date fields to unlock the next stage. Notes are optional.
          </p>
        )}

        <button
          onClick={handleSave}
          disabled={isLoading}
          className="w-full btn-primary py-2.5 flex items-center justify-center gap-2"
        >
          {isLoading ? (
            <>
              <Loader2 className="w-4 h-4 animate-spin" />
              Saving...
            </>
          ) : (
            <>
              <Check className="w-4 h-4" />
              {isComplete ? 'Save & Continue' : 'Save Progress'}
            </>
          )}
        </button>
      </div>

      {(timeline.eta?.completed || timeline.etdEta?.completed) && (
        <AlertCustomerButton
          pkg={pkg}
          stageKey="eta"
          stageData={timeline.eta || timeline.etdEta}
        />
      )}
    </div>
  );
}

function StageClearance({
  pkg,
  timeline,
  currentUser,
  operations,
  onSave,
  isLoading,
}: {
  pkg: Package;
  timeline: any;
  currentUser: AuthUser | null;
  operations: Operation[];
  onSave: (data: any) => Promise<void>;
  isLoading: boolean;
}) {
  const clearanceData = timeline.clearance || {};
  const clearanceOps = operations.find((op) => op.type === 'Clearance');
  const statusOptions = clearanceOps?.status || [];

  const [formData, setFormData] = useState({
    status: clearanceData.status || statusOptions[0] || '',
    clearanceDate: formatDateForInput(clearanceData.clearanceDate),
    note: clearanceData.note || '',
  });

  useEffect(() => {
    const c = timeline.clearance || {};
    setFormData({
      status: c.status || statusOptions[0] || '',
      clearanceDate: formatDateForInput(c.clearanceDate),
      note: c.note || '',
    });
  }, [timeline.clearance, statusOptions]);

  const isComplete = !!(formData.status && formData.clearanceDate);

  const handleSave = () =>
    onSave({
      status: formData.status,
      note: formData.note,
      clearanceDate: formData.clearanceDate
        ? new Date(formData.clearanceDate)
        : undefined,
    });

  return (
    <div className="space-y-6">
      <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
        <p className="text-sm text-blue-800">
          <strong>Stage 4:</strong> Select clearance status and date. All fields except notes are required to unlock the next stage.
        </p>
      </div>

      <div className="space-y-4">
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1.5">
            Clearance Status
          </label>
          <select
            value={formData.status}
            onChange={(e) => setFormData({ ...formData, status: e.target.value })}
            className="input-field"
          >
            {statusOptions.map((status) => (
              <option key={status} value={status}>
                {status}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1.5">
            Clearance Date
          </label>
          <input
            type="date"
            value={formData.clearanceDate}
            onChange={(e) =>
              setFormData({ ...formData, clearanceDate: e.target.value })
            }
            className="input-field"
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1.5">
            Common Note
          </label>
          <textarea
            value={formData.note}
            onChange={(e) => setFormData({ ...formData, note: e.target.value })}
            className="input-field resize-none"
            rows={3}
            placeholder="Add any notes about this stage..."
          />
        </div>

        {!isComplete && (
          <p className="text-xs text-amber-600">
            Fill status and date to unlock the next stage. Notes are optional.
          </p>
        )}

        <button
          onClick={handleSave}
          disabled={isLoading}
          className="w-full btn-primary py-2.5 flex items-center justify-center gap-2"
        >
          {isLoading ? (
            <>
              <Loader2 className="w-4 h-4 animate-spin" />
              Saving...
            </>
          ) : (
            <>
              <Check className="w-4 h-4" />
              {isComplete ? 'Save & Continue' : 'Save Progress'}
            </>
          )}
        </button>
      </div>

      {timeline.clearance?.completed && (
        <AlertCustomerButton
          pkg={pkg}
          stageKey="clearance"
          stageData={timeline.clearance}
        />
      )}
    </div>
  );
}

function StageCargoSegregation({
  pkg,
  timeline,
  currentUser,
  operations,
  onSave,
  isLoading,
}: {
  pkg: Package;
  timeline: any;
  currentUser: AuthUser | null;
  operations: Operation[];
  onSave: (data: any) => Promise<void>;
  isLoading: boolean;
}) {
  const cargoData = timeline.cargoSegregation || {};
  const cargoOps = operations.find((op) => op.type === 'Cargo Segregation');
  const statusOptions = cargoOps?.status || [];

  const [formData, setFormData] = useState({
    status: cargoData.status || statusOptions[0] || '',
    segregationDate: formatDateForInput(cargoData.segregationDate),
    note: cargoData.note || '',
  });

  useEffect(() => {
    const c = timeline.cargoSegregation || {};
    setFormData({
      status: c.status || statusOptions[0] || '',
      segregationDate: formatDateForInput(c.segregationDate),
      note: c.note || '',
    });
  }, [timeline.cargoSegregation, statusOptions]);

  const isComplete = !!(formData.status && formData.segregationDate);

  const handleSave = () =>
    onSave({
      status: formData.status,
      note: formData.note,
      segregationDate: formData.segregationDate
        ? new Date(formData.segregationDate)
        : undefined,
    });

  return (
    <div className="space-y-6">
      <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
        <p className="text-sm text-blue-800">
          <strong>Stage 5:</strong> Record cargo segregation status and date. All fields except notes are required to unlock the next stage.
        </p>
      </div>

      <div className="space-y-4">
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1.5">
            Cargo Segregation Status
          </label>
          <select
            value={formData.status}
            onChange={(e) => setFormData({ ...formData, status: e.target.value })}
            className="input-field"
          >
            {statusOptions.map((status) => (
              <option key={status} value={status}>
                {status}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1.5">
            Segregation Date
          </label>
          <input
            type="date"
            value={formData.segregationDate}
            onChange={(e) =>
              setFormData({ ...formData, segregationDate: e.target.value })
            }
            className="input-field"
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1.5">
            Common Note
          </label>
          <textarea
            value={formData.note}
            onChange={(e) => setFormData({ ...formData, note: e.target.value })}
            className="input-field resize-none"
            rows={3}
            placeholder="Add any notes about this stage..."
          />
        </div>

        {!isComplete && (
          <p className="text-xs text-amber-600">
            Fill status and date to unlock the next stage. Notes are optional.
          </p>
        )}

        <button
          onClick={handleSave}
          disabled={isLoading}
          className="w-full btn-primary py-2.5 flex items-center justify-center gap-2"
        >
          {isLoading ? (
            <>
              <Loader2 className="w-4 h-4 animate-spin" />
              Saving...
            </>
          ) : (
            <>
              <Check className="w-4 h-4" />
              {isComplete ? 'Save & Continue' : 'Save Progress'}
            </>
          )}
        </button>
      </div>

      {timeline.cargoSegregation?.completed && (
        <AlertCustomerButton
          pkg={pkg}
          stageKey="cargoSegregation"
          stageData={timeline.cargoSegregation}
        />
      )}
    </div>
  );
}

function StageBilling({
  pkg,
  timeline,
  currentUser,
  operations,
  onSave,
  isLoading,
}: {
  pkg: Package;
  timeline: any;
  currentUser: AuthUser | null;
  operations: Operation[];
  onSave: (data: any) => Promise<void>;
  isLoading: boolean;
}) {
  const billingData = timeline.billing || {};
  const billingOps = operations.find((op) => op.type === 'Billing');
  const statusOptions = billingOps?.status || [];

  const [formData, setFormData] = useState({
    status: billingData.status || statusOptions[0] || '',
    billingDate: formatDateForInput(billingData.billingDate),
    note: billingData.note || '',
  });

  useEffect(() => {
    const b = timeline.billing || {};
    setFormData({
      status: b.status || statusOptions[0] || '',
      billingDate: formatDateForInput(b.billingDate),
      note: b.note || '',
    });
  }, [timeline.billing, statusOptions]);

  const isComplete = !!(formData.status && formData.billingDate);

  const handleSave = () =>
    onSave({
      status: formData.status,
      note: formData.note,
      billingDate: formData.billingDate ? new Date(formData.billingDate) : undefined,
    });

  return (
    <div className="space-y-6">
      <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
        <p className="text-sm text-blue-800">
          <strong>Stage 6:</strong> Record billing status and date. All fields except notes are required to unlock the next stage.
        </p>
      </div>

      <div className="space-y-4">
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1.5">
            Billing Status
          </label>
          <select
            value={formData.status}
            onChange={(e) => setFormData({ ...formData, status: e.target.value })}
            className="input-field"
          >
            {statusOptions.map((status) => (
              <option key={status} value={status}>
                {status}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1.5">
            Billing Date
          </label>
          <input
            type="date"
            value={formData.billingDate}
            onChange={(e) =>
              setFormData({ ...formData, billingDate: e.target.value })
            }
            className="input-field"
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1.5">
            Common Note
          </label>
          <textarea
            value={formData.note}
            onChange={(e) => setFormData({ ...formData, note: e.target.value })}
            className="input-field resize-none"
            rows={3}
            placeholder="Add any notes about this stage..."
          />
        </div>

        {!isComplete && (
          <p className="text-xs text-amber-600">
            Fill status and date to unlock the next stage. Notes are optional.
          </p>
        )}

        <button
          onClick={handleSave}
          disabled={isLoading}
          className="w-full btn-primary py-2.5 flex items-center justify-center gap-2"
        >
          {isLoading ? (
            <>
              <Loader2 className="w-4 h-4 animate-spin" />
              Saving...
            </>
          ) : (
            <>
              <Check className="w-4 h-4" />
              {isComplete ? 'Save & Continue' : 'Save Progress'}
            </>
          )}
        </button>
      </div>

      {timeline.billing?.completed && (
        <AlertCustomerButton
          pkg={pkg}
          stageKey="billing"
          stageData={timeline.billing}
        />
      )}
    </div>
  );
}

function StagePayment({
  pkg,
  timeline,
  currentUser,
  operations,
  onSave,
  isLoading,
}: {
  pkg: Package;
  timeline: any;
  currentUser: AuthUser | null;
  operations: Operation[];
  onSave: (data: any) => Promise<void>;
  isLoading: boolean;
}) {
  const paymentData = timeline.payment || {};
  const paymentOps = operations.find((op) => op.type === 'Payment');
  const statusOptions = paymentOps?.status || [];

  const [formData, setFormData] = useState({
    status: paymentData.status || statusOptions[0] || '',
    paymentDate: formatDateForInput(paymentData.paymentDate),
    note: paymentData.note || '',
  });

  useEffect(() => {
    const p = timeline.payment || {};
    setFormData({
      status: p.status || statusOptions[0] || '',
      paymentDate: formatDateForInput(p.paymentDate),
      note: p.note || '',
    });
  }, [timeline.payment, statusOptions]);

  const handleSave = () =>
    onSave({
      status: formData.status,
      note: formData.note,
      paymentDate: formData.paymentDate ? new Date(formData.paymentDate) : undefined,
    });

  return (
    <div className="space-y-6">
      <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
        <p className="text-sm text-blue-800">
          <strong>Stage 6:</strong> Record payment status and date.
        </p>
      </div>

      <div className="space-y-4">
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1.5">
            Payment Status
          </label>
          <select
            value={formData.status}
            onChange={(e) => setFormData({ ...formData, status: e.target.value })}
            className="input-field"
          >
            {statusOptions.map((status) => (
              <option key={status} value={status}>
                {status}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1.5">
            Payment Date
          </label>
          <input
            type="date"
            value={formData.paymentDate}
            onChange={(e) =>
              setFormData({ ...formData, paymentDate: e.target.value })
            }
            className="input-field"
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1.5">
            Common Note
          </label>
          <textarea
            value={formData.note}
            onChange={(e) => setFormData({ ...formData, note: e.target.value })}
            className="input-field resize-none"
            rows={3}
            placeholder="Add any notes about this stage..."
          />
        </div>

        <button
          onClick={handleSave}
          disabled={isLoading}
          className="w-full btn-primary py-2.5 flex items-center justify-center gap-2"
        >
          {isLoading ? (
            <>
              <Loader2 className="w-4 h-4 animate-spin" />
              Saving...
            </>
          ) : (
            <>
              <Check className="w-4 h-4" />
              Save & Continue
            </>
          )}
        </button>
        <p className="text-xs text-gray-500">
          Payment stage can be saved and continued without filling all fields.
        </p>
      </div>

      {timeline.payment?.completed && (
        <AlertCustomerButton
          pkg={pkg}
          stageKey="payment"
          stageData={timeline.payment}
        />
      )}
    </div>
  );
}

function StageDispatch({
  pkg,
  timeline,
  operations,
  onSave,
  isLoading,
}: {
  pkg: Package;
  timeline: any;
  operations: Operation[];
  onSave: (data: any) => Promise<void>;
  isLoading: boolean;
}) {
  const dispatchData = timeline.dispatch || {};
  const dispatchOps = operations.find((op) => op.type === 'Dispatch Status');
  const statusOptions = dispatchOps?.status || [];

  const [formData, setFormData] = useState({
    status: dispatchData.status || statusOptions[0] || '',
    driverName: dispatchData.driverName || '',
    driverPhone: dispatchData.driverPhone || '',
    truckNo: dispatchData.truckNo || '',
    dispatchDate: formatDateForInput(dispatchData.dispatchDate),
    note: dispatchData.note || '',
  });

  useEffect(() => {
    const d = timeline.dispatch || {};
    setFormData({
      status: d.status || statusOptions[0] || '',
      driverName: d.driverName || '',
      driverPhone: d.driverPhone || '',
      truckNo: d.truckNo || '',
      dispatchDate: formatDateForInput(d.dispatchDate),
      note: d.note || '',
    });
  }, [timeline.dispatch, statusOptions]);

  const isDispatched = formData.status?.toLowerCase() === 'dispatched';
  const isComplete =
    !!formData.status &&
    !!formData.dispatchDate &&
    (!isDispatched || !!(formData.driverName && formData.driverPhone && formData.truckNo));

  const handleSave = () =>
    onSave({
      status: formData.status,
      driverName: formData.driverName,
      driverPhone: formData.driverPhone,
      note: formData.note,
      truckNo: formData.truckNo,
      dispatchDate: formData.dispatchDate
        ? new Date(formData.dispatchDate)
        : undefined,
    });

  return (
    <div className="space-y-6">
      <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
        <p className="text-sm text-blue-800">
          <strong>Stage 8 (Final):</strong> Record dispatch details. Driver
          information is required when status is &quot;Dispatched&quot;. All fields except notes are required to complete this stage.
        </p>
      </div>

      <div className="space-y-4">
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1.5">
            Dispatch Status
          </label>
          <select
            value={formData.status}
            onChange={(e) => setFormData({ ...formData, status: e.target.value })}
            className="input-field"
          >
            {statusOptions.map((status) => (
              <option key={status} value={status}>
                {status}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1.5">
            Dispatch Date
          </label>
          <input
            type="date"
            value={formData.dispatchDate}
            onChange={(e) =>
              setFormData({ ...formData, dispatchDate: e.target.value })
            }
            className="input-field"
          />
        </div>

        {isDispatched && (
          <>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">
                Driver Name *
              </label>
              <input
                type="text"
                value={formData.driverName}
                onChange={(e) =>
                  setFormData({ ...formData, driverName: e.target.value })
                }
                className="input-field"
                placeholder="Enter driver name"
                required
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">
                Driver Phone *
              </label>
              <input
                type="tel"
                value={formData.driverPhone}
                onChange={(e) =>
                  setFormData({ ...formData, driverPhone: e.target.value })
                }
                className="input-field"
                placeholder="Enter driver phone"
                required
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">
                Truck No *
              </label>
              <input
                type="text"
                value={formData.truckNo}
                onChange={(e) =>
                  setFormData({ ...formData, truckNo: e.target.value })
                }
                className="input-field"
                placeholder="Enter truck number"
                required
              />
            </div>
          </>
        )}

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1.5">
            Common Note
          </label>
          <textarea
            value={formData.note}
            onChange={(e) => setFormData({ ...formData, note: e.target.value })}
            className="input-field resize-none"
            rows={3}
            placeholder="Add any notes about this stage..."
          />
        </div>

        {!isComplete && (
          <p className="text-xs text-amber-600">
            Fill all required fields to complete this stage. Notes are optional.
          </p>
        )}

        <button
          onClick={handleSave}
          disabled={isLoading}
          className="w-full btn-primary py-2.5 flex items-center justify-center gap-2"
        >
          {isLoading ? (
            <>
              <Loader2 className="w-4 h-4 animate-spin" />
              Saving...
            </>
          ) : (
            <>
              <Check className="w-4 h-4" />
              {isComplete ? 'Save & Continue' : 'Save Progress'}
            </>
          )}
        </button>
      </div>

      {timeline.dispatch?.completed && (
        <AlertCustomerButton
          pkg={pkg}
          stageKey="dispatch"
          stageData={timeline.dispatch}
        />
      )}
    </div>
  );
}

function AlertCustomerButton({
  pkg,
  stageKey,
  stageData,
}: {
  pkg: Package;
  stageKey: string;
  stageData: Record<string, unknown>;
}) {
  const [showConfirm, setShowConfirm] = useState(false);

  const handleAlert = () => {
    const message = buildWhatsAppAlertMessage(pkg, stageKey, stageData);
    const whatsappUrl = `https://wa.me/?text=${encodeURIComponent(message)}`;
    window.open(whatsappUrl, '_blank', 'noopener,noreferrer');
    setShowConfirm(false);
  };

  return (
    <>
      <button
        onClick={() => setShowConfirm(true)}
        className="w-full btn-secondary py-2.5 flex items-center justify-center gap-2 border-blue-200"
      >
        <Bell className="w-4 h-4 text-blue-600" />
        Alert Customer via WhatsApp
      </button>

      {showConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-50">
          <div className="bg-white rounded-xl p-6 max-w-md w-full mx-4 shadow-lg">
            <h3 className="text-lg font-bold text-gray-900 mb-2">
              Send WhatsApp Update?
            </h3>
            <p className="text-gray-600 mb-4 text-sm">
              This opens WhatsApp so you can choose a contact. The message will include
              vendor, package type, CTN, weight, CBM, and ETA date.
            </p>
            <div className="flex gap-3">
              <button
                onClick={() => setShowConfirm(false)}
                className="flex-1 btn-secondary py-2"
              >
                Cancel
              </button>
              <button
                onClick={handleAlert}
                className="flex-1 btn-primary py-2 bg-green-600 hover:bg-green-700"
              >
                Open WhatsApp
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
