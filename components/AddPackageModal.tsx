// src/components/AddPackageModal.tsx
'use client';
/* eslint-disable react-hooks/set-state-in-effect */

import { useState, useEffect } from 'react';
import {
  collection,
  addDoc,
  updateDoc,
  doc,
  getDoc,
  getDocs,
  query,
  orderBy,
  Timestamp,
  arrayUnion,
} from 'firebase/firestore';
import { db } from '@/lib/firebase';
import { uploadSupportDocuments } from '@/lib/storage-upload';
import SupportDocumentsPicker, {
  PendingSupportFile,
} from '@/components/SupportDocumentsPicker';
import { X, Loader2 } from 'lucide-react';
import { Package, AuthUser, Vendor } from '@/types';


interface AddPackageModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: () => void;
  editingPackage?: Package | null;
  currentUser: AuthUser | null;
}

export default function AddPackageModal({
  isOpen,
  onClose,
  onSuccess,
  editingPackage,
  currentUser,
}: AddPackageModalProps) {
  const [name, setName] = useState('');
  const [vendorId, setVendorId] = useState('');
  const [vendorSearch, setVendorSearch] = useState('');
  const [showVendorSuggestions, setShowVendorSuggestions] = useState(false);
  const [status, setStatus] = useState<Package['status']>('in_process');
  const [description, setDescription] = useState('');
  const [blNo, setBlNo] = useState('');
  const [containerNo, setContainerNo] = useState('');
  const [amountPerCbm, setAmountPerCbm] = useState('');
  const [weightType, setWeightType] = useState<Package['weightType']>('KG');
  const [weight, setWeight] = useState('');
  const [cbm, setCbm] = useState('');
  const [packageType, setPackageType] = useState('');
  const [packageTypeSuggestions, setPackageTypeSuggestions] = useState<string[]>([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [packageCount, setPackageCount] = useState('');
  const [otherExpenses, setOtherExpenses] = useState('0');
  const [transportExpenses, setTransportExpenses] = useState('0');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');
  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [pendingFiles, setPendingFiles] = useState<PendingSupportFile[]>([]);

  const filteredVendors = vendors.filter((vendor) => {
    const q = vendorSearch.trim().toLowerCase();
    if (!q) return true;
    return (
      vendor.name.toLowerCase().includes(q) ||
      vendor.mobile.toLowerCase().includes(q)
    );
  });

  const computedTotalAmount = (() => {
    const amount = parseFloat(amountPerCbm) || 0;
    const cbmValue = parseFloat(cbm) || 0;
    const other = parseFloat(otherExpenses) || 0;
    const transport = parseFloat(transportExpenses) || 0;

    return amount * cbmValue + other + transport;
  })();

  const resetForm = () => {
    setName('');
    setVendorId('');
    setVendorSearch('');
    setShowVendorSuggestions(false);
    setStatus('in_process');
    setDescription('');
    setBlNo('');
    setContainerNo('');
    setAmountPerCbm('');
    setWeightType('KG');
    setWeight('');
    setCbm('');
    setPackageType('');
    setPackageCount('');
    setOtherExpenses('0');
    setTransportExpenses('0');
    setShowSuggestions(false);
    setPendingFiles([]);
    setError('');
  };

  const handleAddFiles = (files: File[]) => {
    const next = files.map((file) => ({
      id: `${file.name}-${file.size}-${file.lastModified}-${Math.random()}`,
      file,
    }));
    setPendingFiles((prev) => [...prev, ...next]);
  };

  const fetchVendors = async () => {
    try {
      const vendorsRef = collection(db, 'vendors');
      const q = query(vendorsRef, orderBy('createdAt', 'desc'));
      const snapshot = await getDocs(q);
      const loadedVendors: Vendor[] = [];

      snapshot.forEach((docSnap) => {
        const data = docSnap.data();
        loadedVendors.push({
          id: docSnap.id,
          name: data.name || '',
          mobile: data.mobile || '',
          mailId: data.mailId || '',
          address: data.address || '',
          billingAddress: data.billingAddress || '',
          createdAt: data.createdAt?.toDate?.() || new Date(),
          updatedAt: data.updatedAt?.toDate?.() || new Date(),
        });
      });

      setVendors(loadedVendors);
    } catch (err) {
      console.error('Error fetching vendors:', err);
      setError('Unable to load vendors. Please try again.');
    }
  };

  const fetchPackageTypes = async () => {
    try {
      const opsRef = collection(db, 'operations');
      const snapshot = await getDocs(opsRef);
      snapshot.forEach((docSnap) => {
        const data = docSnap.data();
        if (data.type === 'Package') {
          setPackageTypeSuggestions(Array.isArray(data.status) ? data.status : []);
        }
      });
    } catch (err) {
      console.error('Error fetching package types:', err);
    }
  };

  useEffect(() => {
    fetchVendors();
    fetchPackageTypes();
  }, []);

  useEffect(() => {
    if (editingPackage) {
      setName(editingPackage.name || '');
      const resolvedVendorId =
        editingPackage.vendorId ||
        vendors.find((vendor) => vendor.name === editingPackage.vendorName)?.id ||
        '';
      setVendorId(resolvedVendorId);
      setVendorSearch(
        vendors.find((vendor) => vendor.id === resolvedVendorId)?.name ||
          editingPackage.vendorName ||
          ''
      );
      setShowVendorSuggestions(false);
      setStatus(editingPackage.status || 'in_process');
      setDescription(editingPackage.description || '');
      setBlNo(editingPackage.blNo || '');
      setContainerNo(editingPackage.containerNo || '');
      setAmountPerCbm(editingPackage.amountPerCbm?.toString() || '');
      setWeightType(editingPackage.weightType || 'KG');
      setWeight(editingPackage.weight?.toString() || '');
      setCbm(editingPackage.cbm?.toString() || '');
      setPackageType(editingPackage.packageType || '');
      setPackageCount(editingPackage.packageCount?.toString() || '');

      // Fetch latest package doc to ensure expense fields (and others) are populated
      (async () => {
        try {
          if (editingPackage.id) {
            const snap = await getDoc(doc(db, 'packages', editingPackage.id));
            if (snap.exists()) {
              const data = snap.data() as any;
              setOtherExpenses(data.otherExpenses != null ? String(data.otherExpenses) : '0');
              setTransportExpenses(data.transportExpenses != null ? String(data.transportExpenses) : '0');
              // if needed, override other fields with freshest values
              setName(data.name || editingPackage.name || '');
              setDescription(data.description || editingPackage.description || '');
            } else {
              setOtherExpenses((editingPackage as any).otherExpenses?.toString() || '0');
              setTransportExpenses((editingPackage as any).transportExpenses?.toString() || '0');
            }
          } else {
            setOtherExpenses((editingPackage as any).otherExpenses?.toString() || '0');
            setTransportExpenses((editingPackage as any).transportExpenses?.toString() || '0');
          }
        } catch (err) {
          console.error('Error fetching package for edit:', err);
          setOtherExpenses((editingPackage as any).otherExpenses?.toString() || '0');
          setTransportExpenses((editingPackage as any).transportExpenses?.toString() || '0');
        }
      })();

      setPendingFiles([]);
      setError('');
    } else {
      resetForm();
    }
  }, [editingPackage, isOpen, vendors]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setIsLoading(true);

    const selectedVendor = vendors.find((vendor) => vendor.id === vendorId);

    if (!name.trim() || !vendorId || !selectedVendor) {
      setError('Package name and vendor selection are required.');
      setIsLoading(false);
      return;
    }

    try {
      const parsedAmountPerCbm = amountPerCbm ? parseFloat(amountPerCbm) : undefined;
      const parsedOtherExpenses = otherExpenses ? parseFloat(otherExpenses) : 0;
      const parsedTransportExpenses = transportExpenses ? parseFloat(transportExpenses) : 0;
      const parsedCbm = cbm ? parseFloat(cbm) : undefined;
      const calculatedTotalAmount =
        (parsedAmountPerCbm || 0) *
          (parsedCbm || 0) +
        parsedOtherExpenses +
        parsedTransportExpenses;

      const payload: Record<string, unknown> = {
        name: name.trim(),
        vendorId: selectedVendor.id,
        vendorCode: selectedVendor.id,
        vendorName: selectedVendor.name,
        vendorMobile: selectedVendor.mobile || undefined,
        vendorDeliveryAddress: selectedVendor.address || undefined,
        vendorBillingAddress: selectedVendor.billingAddress || undefined,
        status: editingPackage ? status : 'in_process',
        description: description.trim(),
        blNo: blNo.trim() || undefined,
        containerNo: containerNo.trim() || undefined,
        amountPerCbm: parsedAmountPerCbm,
        totalAmount: calculatedTotalAmount,
        weightType,
        weight: weight ? parseFloat(weight) : undefined,
        cbm: parsedCbm,
        packageType: packageType || undefined,
        packageCount: packageCount ? parseInt(packageCount, 10) : undefined,
        otherExpenses: parsedOtherExpenses,
        transportExpenses: parsedTransportExpenses,
        updatedAt: Timestamp.now(),
        updatedBy: currentUser?.username || 'Unknown',
      };
      let packageId = editingPackage?.id;

      // Remove undefined values because Firestore doesn't accept `undefined` fields
      const cleanedPayload = Object.fromEntries(
        Object.entries(payload).filter(([, v]) => v !== undefined)
      );

      if (editingPackage) {
        await updateDoc(doc(db, 'packages', editingPackage.id), cleanedPayload);
      } else {
        const docRef = await addDoc(collection(db, 'packages'), {
          ...cleanedPayload,
          status: 'in_process',
          createdAt: Timestamp.now(),
          createdBy: currentUser?.username || 'Unknown',
        });
        packageId = docRef.id;
      }

      if (packageId && pendingFiles.length > 0) {
        const uploaded = await uploadSupportDocuments(
          packageId,
          pendingFiles.map((item) => item.file)
        );
        const existingDocs = editingPackage?.supportDocuments || [];
        await updateDoc(doc(db, 'packages', packageId), {
          supportDocuments: [...existingDocs, ...uploaded],
          updatedAt: Timestamp.now(),
        });
      }

      // Check if there is a new package type to add to operations
      const trimmedPackageType = packageType.trim();
      if (trimmedPackageType && !packageTypeSuggestions.includes(trimmedPackageType)) {
        try {
          const opsRef = collection(db, 'operations');
          const snapshot = await getDocs(opsRef);
          let packageOpDocId: string | null = null;
          let currentStatuses: string[] = [];
          
          snapshot.forEach((docSnap) => {
            const data = docSnap.data();
            if (data.type === 'Package') {
              packageOpDocId = docSnap.id;
              currentStatuses = Array.isArray(data.status) ? data.status : [];
            }
          });

          if (packageOpDocId) {
            if (!currentStatuses.includes(trimmedPackageType)) {
              await updateDoc(doc(db, 'operations', packageOpDocId), {
                status: arrayUnion(trimmedPackageType),
                updatedAt: Timestamp.now(),
              });
            }
          } else {
            await addDoc(collection(db, 'operations'), {
              type: 'Package',
              status: [trimmedPackageType],
              createdAt: Timestamp.now(),
              updatedAt: Timestamp.now(),
            });
          }
        } catch (err) {
          console.error('Error saving new package type to operations:', err);
        }
      }

      resetForm();
      onSuccess();
      onClose();
    } catch (err) {
      console.error('Error saving package:', err);
      setError('Failed to save package. Please try again.');
    } finally {
      setIsLoading(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl w-full max-w-2xl max-h-[90vh] overflow-y-auto shadow-2xl">
        <div className="flex items-center justify-between p-6 border-b border-gray-100">
          <h2 className="text-xl font-semibold text-gray-900">
            {editingPackage ? 'Edit Package' : 'Add New Package'}
          </h2>
          <button
            onClick={onClose}
            className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-gray-100 transition-colors"
          >
            <X className="w-5 h-5 text-gray-500" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-6 space-y-5">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">
                Package Name *
              </label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="input-field"
                placeholder="Enter package name"
                required
              />
            </div>

            <div className="relative">
              <label className="block text-sm font-medium text-gray-700 mb-1.5">
                Vendor *
              </label>
              <input
                type="text"
                value={vendorSearch}
                onChange={(e) => {
                  const value = e.target.value;
                  setVendorSearch(value);
                  setShowVendorSuggestions(true);
                  const exact = vendors.find(
                    (vendor) => vendor.name.toLowerCase() === value.trim().toLowerCase()
                  );
                  setVendorId(exact?.id || '');
                }}
                onFocus={() => setShowVendorSuggestions(true)}
                onBlur={() => {
                  setTimeout(() => setShowVendorSuggestions(false), 200);
                }}
                className="input-field"
                placeholder="Type to search vendor"
                required
                autoComplete="off"
              />
              {showVendorSuggestions && (
                <div className="absolute z-10 w-full bg-white border border-gray-200 rounded-lg shadow-lg max-h-60 overflow-y-auto mt-1">
                  {filteredVendors.length === 0 ? (
                    <div className="px-4 py-2.5 text-sm text-gray-500">
                      No vendors found
                    </div>
                  ) : (
                    filteredVendors.map((vendor) => (
                      <button
                        key={vendor.id}
                        type="button"
                        onClick={() => {
                          setVendorId(vendor.id);
                          setVendorSearch(vendor.name);
                          setShowVendorSuggestions(false);
                        }}
                        className="w-full text-left px-4 py-2.5 hover:bg-blue-50 text-sm text-gray-700 transition-colors border-b border-gray-50 last:border-b-0"
                      >
                        <span className="font-medium">{vendor.name}</span>
                        {vendor.mobile ? (
                          <span className="text-gray-400 ml-2">{vendor.mobile}</span>
                        ) : null}
                      </button>
                    ))
                  )}
                </div>
              )}
            </div>
          </div>
          

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">
                BL No
              </label>
              <input
                type="text"
                value={blNo}
                onChange={(e) => setBlNo(e.target.value)}
                className="input-field"
                placeholder="Enter BL No"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">
                Container No
              </label>
              <input
                type="text"
                value={containerNo}
                onChange={(e) => setContainerNo(e.target.value)}
                className="input-field"
                placeholder="Enter container no"
              />
            </div>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="relative">
              <label className="block text-sm font-medium text-gray-700 mb-1.5">
                Type of Packages
              </label>
              <input
                type="text"
                value={packageType}
                onChange={(e) => {
                  setPackageType(e.target.value);
                  setShowSuggestions(true);
                }}
                onFocus={() => setShowSuggestions(true)}
                onBlur={() => {
                  setTimeout(() => setShowSuggestions(false), 200);
                }}
                className="input-field"
                placeholder="Type or select package type"
              />
              {showSuggestions && (
                (() => {
                  const filtered = packageTypeSuggestions.filter((suggestion) =>
                    suggestion.toLowerCase().includes(packageType.toLowerCase())
                  );
                  if (filtered.length === 0) return null;
                  return (
                    <div className="absolute z-10 w-full bg-white border border-gray-200 rounded-lg shadow-lg max-h-60 overflow-y-auto mt-1">
                      {filtered.map((suggestion) => (
                        <button
                          key={suggestion}
                          type="button"
                          onClick={() => {
                            setPackageType(suggestion);
                            setShowSuggestions(false);
                          }}
                          className="w-full text-left px-4 py-2.5 hover:bg-blue-50 text-sm text-gray-700 transition-colors border-b border-gray-50 last:border-b-0"
                        >
                          {suggestion}
                        </button>
                      ))}
                    </div>
                  );
                })()
              )}
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">
                No. of Packages
              </label>
              <input
                type="number"
                value={packageCount}
                onChange={(e) => setPackageCount(e.target.value)}
                className="input-field"
                placeholder="Enter package count"
                min="1"
              />
            </div>
          </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">
              Weight
            </label>
            <input
              type="number"
              value={weight}
              onChange={(e) => setWeight(e.target.value)}
              className="input-field"
              placeholder="Enter weight"
              min="0"
              step="0.01"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">
              Weight Type
            </label>
            <select
              value={weightType}
              onChange={(e) =>
                setWeightType(e.target.value as Package['weightType'])
              }
              className="input-field"
            >
              <option value="KG">KG</option>
              <option value="TON">TON</option>
            </select>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">
              CBM (cubic meters)
            </label>
            <input
              type="number"
              value={cbm}
              onChange={(e) => setCbm(e.target.value)}
              className="input-field"
              placeholder="Enter CBM"
              min="0"
              step="0.01"
            />
          </div>
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">
              Amount Per CBM
            </label>
            <input
              type="number"
              value={amountPerCbm}
              onChange={(e) => setAmountPerCbm(e.target.value)}
              className="input-field"
              placeholder="Enter amount per CBM"
              min="0"
              step="0.01"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">
              Other Expenses
            </label>
            <input
              type="number"
              value={otherExpenses}
              onChange={(e) => setOtherExpenses(e.target.value)}
              className="input-field"
              placeholder="Enter other expenses"
              min="0"
              step="0.01"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">
              Transport Expenses
            </label>
            <input
              type="number"
              value={transportExpenses}
              onChange={(e) => setTransportExpenses(e.target.value)}
              className="input-field"
              placeholder="Enter transport expenses"
              min="0"
              step="0.01"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">
              Total Amount
            </label>
            <input
              type="number"
              value={computedTotalAmount.toFixed(2)}
              className="input-field bg-gray-50 text-gray-700"
              placeholder="Calculated total"
              disabled
            />
          </div>
        </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">
              Description
            </label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              className="input-field resize-none"
              placeholder="Describe this package"
              rows={4}
            />
          </div>

          <SupportDocumentsPicker
            pendingFiles={pendingFiles}
            existingDocuments={editingPackage?.supportDocuments}
            onAddFiles={handleAddFiles}
            onRemovePending={(id) =>
              setPendingFiles((prev) => prev.filter((item) => item.id !== id))
            }
            disabled={isLoading}
          />

          {error && (
            <div className="bg-red-50 border border-red-200 text-red-600 px-4 py-3 rounded-lg text-sm">
              {error}
            </div>
          )}

          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-end pt-2">
            <button
              type="button"
              onClick={onClose}
              className="btn-secondary w-full sm:w-auto py-2.5"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={isLoading}
              className="btn-primary w-full sm:w-auto py-2.5 flex items-center justify-center gap-2"
            >
              {isLoading ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  {pendingFiles.length > 0 ? 'Saving & uploading...' : 'Saving...'}
                </>
              ) : editingPackage ? (
                'Update Package'
              ) : (
                'Add Package'
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
