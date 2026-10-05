import React, { useState, useCallback, useEffect, useMemo, useRef } from "react";
import { useAuth } from "../context/AuthContext";
import { useRBAC } from "../context/RBACContext";
import DataTable from "./components/DataTable";
import LoadingSpinner from "./components/LoadingSpinner";
import InlineMetadataModal from "./components/InlineMetadataModal";
// Import icons
import searchIcon from "/icons/JJ_Icon_Search_RGB.svg";
import downloadIcon from "/icons/JJ_Icon_Download_PDF_RGB.svg";
import reset from "/icons/JJ_Icon_Refresh_black.svg";
import dashboardIcon from "/icons/JJ_Icon_Dashboard_RGB.svg";
import collapseIcon from "/icons/JJ_Icon_Chevron_Left.svg";
import expandIcon from "/icons/JJ_Icon_Chevron_Right.svg";
import metadataIcon from "/icons/JJ_Icon_Info_RGB.svg";
import { apiFetch } from '../utils/apiClient';

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL;

const Icon = ({ src, alt, className = "w-4 h-4", style = {} }) => (
  <img src={src} alt={alt} className={className} style={{ filter: 'currentColor', ...style }} />
);

const extractDatasource = (tableName) => {
  const parts = tableName.split('_');
  return parts.length >= 3 ? parts[2].toLowerCase() : 'misc';
};

const formatPct = (val) => {
  if (val === undefined || val === null) return "0%";
  const num = typeof val === "number" ? val : parseFloat(val);
  return `${(num <= 1 ? num * 100 : num).toFixed(1)}%`;
};

const Metric = ({ title, value }) => (
  <div className="bg-white border border-jj-gray-03 rounded-lg p-3 hover:shadow-sm transition-shadow">
    <div className="text-xs font-johnson-text text-jj-gray-06 mb-1" style={{ lineHeight: '120%' }}>{title}</div>
    <div className="text-xl font-johnson-display text-jj-gray-08" style={{ lineHeight: '110%' }}>{value}</div>
  </div>
);

const fetchMetadataForView = async (viewName, options = {}) => {
  const resp = await apiFetch(`/metadata`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      search_text: viewName,
      element_type: options.elementType || "Views",
      with_endorsements: options.withEndorsements !== undefined ? options.withEndorsements : false,
      with_warnings: options.withWarnings !== undefined ? options.withWarnings : false,
      with_deprecations: options.withDeprecations !== undefined ? options.withDeprecations : false,
      category_ids: options.categoryIds || [],
      tag_ids: options.tagIds || [],
      database_ids: options.databaseIds || [],
      where_to_search_list: options.whereToSearchList || ["ELEMENT_NAME"],
      search_type: options.searchType || "EXACT_MATCH",
      offset: options.offset || 0,
      limit: options.limit || 1000000
    }),
  });

  if (!resp.ok) throw new Error((await resp.text()) || `HTTP ${resp.status}`);
  const data = await resp.json();
  return data.metadata || [];
};

// Custom hook for search functionality
const useSearch = (credentials) => {
  const [searchText, setSearchText] = useState("");
  const [searchPerformed, setSearchPerformed] = useState(false);
  const [lastSearchedTerm, setLastSearchedTerm] = useState("");
  const [results, setResults] = useState({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [datasourceFilter, setDatasourceFilter] = useState([]);

  useEffect(() => {
    try {
      const savedData = localStorage.getItem('jj_fuzzy_search_data');
      if (savedData) {
        const parsed = JSON.parse(savedData);
        setSearchText(parsed.searchText || "");
        setSearchPerformed(parsed.searchPerformed || false);
        setResults(parsed.results || {});
        // Handle backward compatibility: convert old string format to array
        if (parsed.datasourceFilter) {
          if (Array.isArray(parsed.datasourceFilter)) {
            setDatasourceFilter(parsed.datasourceFilter);
          } else if (parsed.datasourceFilter !== 'all') {
            setDatasourceFilter([parsed.datasourceFilter]);
          } else {
            setDatasourceFilter([]);
          }
        } else {
          setDatasourceFilter([]);
        }
      }
    } catch (error) {
      console.warn('Error loading search state:', error);
    }
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem('jj_fuzzy_search_data', JSON.stringify({
        searchText, searchPerformed, results, datasourceFilter, lastUpdated: new Date().toISOString()
      }));
    } catch (error) {
      console.warn('Error saving search state:', error);
    }
  }, [searchText, searchPerformed, results, datasourceFilter]);

  const handleSearch = useCallback(async (e) => {
    if (e) e.preventDefault();
    if (!searchText.trim()) {
      setError("Please enter search text");
      return;
    }

    setError("");
    setLoading(true);
    setSearchPerformed(false);
    setResults({});

    try {
      const resp = await apiFetch(`/search`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          search_text: searchText.trim(),
        }),
      });

      if (!resp.ok) throw new Error((await resp.text()) || `HTTP ${resp.status}`);
      const data = await resp.json();

      // First, collect all results with records
      const allResults = {};
      Object.keys(data.results || {}).forEach((viewName) => {
        const viewData = data.results[viewName];
        if ((viewData?.records?.length || 0) > 0) {
          allResults[viewName] = viewData;
        }
      });

      // Apply datasource filter on frontend if datasources are selected
      let filteredResults = allResults;
      if (datasourceFilter && datasourceFilter.length > 0) {
        filteredResults = {};
        const datasourcesLower = datasourceFilter.map(ds => ds.toLowerCase());
        Object.keys(allResults).forEach((viewName) => {
          // Extract datasource from view name (3rd part when split by underscore)
          const parts = viewName.split('_');
          if (parts.length >= 3) {
            const viewDatasource = parts[2].toLowerCase();
            if (datasourcesLower.includes(viewDatasource)) {
              filteredResults[viewName] = allResults[viewName];
            }
          }
        });
      }

      setResults(filteredResults);
      setSearchPerformed(true);
      setLastSearchedTerm(searchText.trim());
    } catch (err) {
      console.error("Search error:", err);
      setError(err.message || "Search failed. Please try again.");
    } finally {
      setLoading(false);
    }
  }, [searchText, datasourceFilter]);

  const resetSearch = () => {
    setSearchText("");
    setSearchPerformed(false);
    setResults({});
    setError("");
    setLastSearchedTerm("");
    setDatasourceFilter([]);
    try {
      localStorage.removeItem('jj_fuzzy_search_data');
    } catch (error) {
      console.warn('Error clearing search data:', error);
    }
  };

  return { searchText, setSearchText, searchPerformed, results, loading, error, handleSearch, resetSearch, lastSearchedTerm, datasourceFilter, setDatasourceFilter };
};

// Custom hook for metadata functionality
const useMetadata = (credentials) => {
  const [metadataResults, setMetadataResults] = useState([]);
  const [metadataLoading, setMetadataLoading] = useState(false);
  const [metadataError, setMetadataError] = useState("");
  const [metadataSearchPerformed, setMetadataSearchPerformed] = useState(false);
  const [lastMetadataSearchTerm, setLastMetadataSearchTerm] = useState("");
  const [metadataDatasourceFilter, setMetadataDatasourceFilter] = useState([]);

  const fetchMetadata = useCallback(async (searchText = "", options = {}, datasourceFilter = []) => {
    setMetadataError("");
    setMetadataLoading(true);
    setMetadataSearchPerformed(false);
    setMetadataResults([]);

    try {
      const metadataArray = await fetchMetadataForView(searchText, options);

      // Apply datasource filter on frontend if datasources are selected
      let filteredMetadata = metadataArray;
      if (datasourceFilter && datasourceFilter.length > 0) {
        filteredMetadata = [];
        const datasourcesLower = datasourceFilter.map(ds => ds.toLowerCase());
        metadataArray.forEach((metadata) => {
          // Check multiple possible fields for datasource information
          const metadataName = metadata.name || "";
          const databaseName = metadata.database_name || "";

          // Extract datasource from name (3rd part when split by underscore)
          const nameParts = metadataName.split('_');
          let matchesFilter = false;

          if (nameParts.length >= 3) {
            const nameDatasource = nameParts[2].toLowerCase();
            if (datasourcesLower.includes(nameDatasource)) {
              matchesFilter = true;
            }
          }

          // Also check database_name if available
          if (datasourcesLower.some(ds => databaseName.toLowerCase().includes(ds))) {
            matchesFilter = true;
          }

          if (matchesFilter) {
            filteredMetadata.push(metadata);
          }
        });
      }

      setMetadataResults(filteredMetadata);
      setMetadataSearchPerformed(true);
      setLastMetadataSearchTerm(searchText);
      setMetadataDatasourceFilter(datasourceFilter);
    } catch (err) {
      console.error("Metadata fetch error:", err);
      setMetadataError(err.message || "Metadata fetch failed. Please try again.");
    } finally {
      setMetadataLoading(false);
    }
  }, []);

  const resetMetadata = () => {
    setMetadataResults([]);
    setMetadataError("");
    setMetadataSearchPerformed(false);
    setLastMetadataSearchTerm("");
    setMetadataDatasourceFilter([]);
  };

  return { metadataResults, metadataLoading, metadataError, metadataSearchPerformed, lastMetadataSearchTerm, fetchMetadata, resetMetadata, metadataDatasourceFilter, setMetadataDatasourceFilter };
};

// Download function with progress tracking
const downloadExcel = async (results, setLoading, setError, includeMetadata = false, onProgress = null) => {
  if (!results || Object.keys(results).length === 0) {
    setError("No results to download");
    return;
  }

  setError("");
  setLoading(true);

  try {
    let metadata = {};

    if (includeMetadata) {
      const viewNames = Object.keys(results);
      const totalTables = viewNames.length;
      let completedTables = 0;

      onProgress?.({ stage: 'metadata', current: 0, total: totalTables, message: `Fetching metadata for ${totalTables} tables...` });

      const metadataPromises = viewNames.map(async (viewName) => {
        try {
          const metadataArray = await fetchMetadataForView(viewName);
          const filteredMetadata = metadataArray.filter(item => item.name === viewName);

          completedTables++;
          onProgress?.({ stage: 'metadata', current: completedTables, total: totalTables, message: `Fetching metadata: ${completedTables}/${totalTables} tables` });

          if (filteredMetadata.length > 0) return { viewName, metadata: filteredMetadata[0] };
        } catch (err) {
          console.warn(`Failed to fetch metadata for ${viewName}:`, err);
          completedTables++;
          onProgress?.({ stage: 'metadata', current: completedTables, total: totalTables, message: `Fetching metadata: ${completedTables}/${totalTables} tables` });
        }
        return null;
      });

      const metadataResults = await Promise.all(metadataPromises);
      metadataResults.forEach(result => {
        if (result) metadata[result.viewName] = result.metadata;
      });
    }

    onProgress?.({ stage: 'excel', current: 0, total: 1, message: 'Generating Excel file...' });

    const resp = await apiFetch(`/download`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ results: results, metadata: includeMetadata ? metadata : null }),
    });

    if (!resp.ok) throw new Error((await resp.text()) || `HTTP ${resp.status}`);

    const data = await resp.json();
    if (!data.file) throw new Error("No file returned from server");

    onProgress?.({ stage: 'download', current: 1, total: 1, message: 'Preparing download...' });

    const byteCharacters = atob(data.file);
    const byteArray = new Uint8Array(Array.from(byteCharacters, char => char.charCodeAt(0)));
    const blob = new Blob([byteArray], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });

    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `search_results_${new Date().toISOString().split('T')[0]}.xlsx`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(link.href);

    onProgress?.({ stage: 'complete', current: 1, total: 1, message: 'Download complete!' });
  } catch (err) {
    console.error("Download error:", err);
    setError(err.message || "Download failed. Please try again.");
  } finally {
    setLoading(false);
  }
};

// Download options Modal with Progress
const DownloadOptionsModal = ({ onClose, onDownload, loading, progress }) => {
  const progressStages = { metadata: 'Fetching metadata...', excel: 'Generating Excel...', download: 'Preparing download...', complete: 'Complete!' };

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50" onClick={() => !loading && onClose()}>
      <div className="bg-white rounded-lg shadow-xl p-6 max-w-md w-full mx-4" onClick={(e) => e.stopPropagation()}>
        <div className="mb-4">
          <h3 className="text-xl font-johnson-display text-jj-gray-08" style={{ lineHeight: '110%' }}>Download options</h3>
          <p className="text-sm text-jj-gray-06 mt-1 font-johnson-text" style={{ lineHeight: '120%' }}>Choose how you want to export your search results</p>
        </div>

        {!loading && !progress ? (
          <div className="space-y-3">
            <button onClick={() => onDownload(false)} className="w-full px-4 py-3 bg-jj-blue-03 text-white rounded-lg hover:bg-jj-blue-05 transition-colors flex items-center justify-between group">
              <div className="flex items-center gap-3">
                <Icon src={downloadIcon} alt="Download" className="w-5 h-5" style={{ filter: 'brightness(0) invert(1)' }} />
                <div className="text-left">
                  <div className="font-johnson-text" style={{ fontWeight: '400' }}>Data only</div>
                  <div className="text-xs text-white/80">Quick download without metadata</div>
                </div>
              </div>
              <svg className="w-5 h-5 group-hover:translate-x-1 transition-transform" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
              </svg>
            </button>

            <button onClick={() => onDownload(true)} className="w-full px-4 py-3 bg-jj-green-03 text-white rounded-lg hover:bg-jj-green-05 transition-colors flex items-center justify-between group">
              <div className="flex items-center gap-3">
                <Icon src={downloadIcon} alt="Download" className="w-5 h-5" style={{ filter: 'brightness(0) invert(1)' }} />
                <div className="text-left">
                  <div className="font-johnson-text" style={{ fontWeight: '500' }}>Data + Metadata</div>
                  <div className="text-xs text-white/80">Complete export (takes longer)</div>
                </div>
              </div>
              <svg className="w-5 h-5 group-hover:translate-x-1 transition-transform" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
              </svg>
            </button>

            <button onClick={onClose} className="w-full px-4 py-2 text-jj-gray-06 hover:text-jj-gray-08 transition-colors text-sm font-johnson-text">Cancel</button>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="flex items-center gap-3">
              {progress?.stage === 'complete' ? (
                <div className="w-10 h-10 bg-green-100 rounded-full flex items-center justify-center">
                  <svg className="w-6 h-6 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                  </svg>
                </div>
              ) : (
                <LoadingSpinner />
              )}
              <div className="flex-1">
                <div className="text-sm font-johnson-text text-jj-gray-08">{progressStages[progress?.stage] || 'Processing...'}</div>
                {progress?.message && <div className="text-xs text-jj-gray-06 mt-1">{progress.message}</div>}
              </div>
            </div>

            {progress && progress.stage !== 'complete' && (
              <div className="w-full bg-jj-gray-02 rounded-full h-2 overflow-hidden">
                <div className="bg-jj-blue-03 h-full transition-all duration-300 ease-out" style={{ width: `${(progress.current / progress.total) * 100}%` }} />
              </div>
            )}

            {progress?.stage === 'complete' && (
              <div className="flex items-center justify-center gap-2 text-green-600 font-johnson-text" style={{ fontWeight: '500' }}>
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                </svg>
                <span>Done</span>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

// Unified Results Sidebar Component
const ResultsSidebar = ({ results, selectedTable, onTableSelect, isExpanded, onToggle, tabSearchTerm, onTabSearchChange, onExport, searchedKeyword, isMetadataView = false, sidebarWidth, setSidebarWidth }) => {
  const [isResizing, setIsResizing] = useState(false);
  const resizeRef = useRef({ startX: 0, startWidth: 0 });

  const viewNames = Object.keys(results || {});
  const totalRecords = useMemo(() => viewNames.reduce((sum, name) => sum + (results[name]?.records?.length || 0), 0), [results, viewNames]);
  const filteredTables = useMemo(() => {
    if (!tabSearchTerm.trim()) return viewNames;
    const searchLower = tabSearchTerm.toLowerCase();
    return viewNames.filter(name => name.toLowerCase().includes(searchLower));
  }, [viewNames, tabSearchTerm]);

  const minWidth = 64; // Collapsed width
  const maxWidth = 600; // Maximum width
  const defaultExpandedWidth = 320; // Default expanded width

  const handleMouseDown = (e) => {
    if (!isExpanded) return;
    setIsResizing(true);
    resizeRef.current = {
      startX: e.clientX,
      startWidth: sidebarWidth
    };
    e.preventDefault();
    e.stopPropagation();
  };

  useEffect(() => {
    if (!isResizing) return;

    let animationFrameId = null;

    const handleMouseMove = (e) => {
      if (animationFrameId) {
        cancelAnimationFrame(animationFrameId);
      }

      animationFrameId = requestAnimationFrame(() => {
        const deltaX = e.clientX - resizeRef.current.startX;
        const newWidth = resizeRef.current.startWidth + deltaX;

        // Clamp the width between min and max
        const clampedWidth = Math.max(defaultExpandedWidth, Math.min(maxWidth, newWidth));
        setSidebarWidth(clampedWidth);
      });
    };

    const handleMouseUp = () => {
      setIsResizing(false);
      if (animationFrameId) {
        cancelAnimationFrame(animationFrameId);
      }
    };

    // Prevent text selection and set cursor
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    document.body.style.webkitUserSelect = 'none';

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);

    return () => {
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      document.body.style.webkitUserSelect = '';
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      if (animationFrameId) {
        cancelAnimationFrame(animationFrameId);
      }
    };
  }, [isResizing, setSidebarWidth, defaultExpandedWidth, maxWidth]);

  const currentWidth = isExpanded ? sidebarWidth : minWidth;

  return (
    <div
      className={`bg-white shadow-sm flex flex-col h-full relative ${!isResizing ? 'transition-all duration-300 ease-in-out' : ''}`}
      style={{
        width: `${currentWidth}px`,
        minWidth: `${currentWidth}px`,
        maxWidth: `${currentWidth}px`,
        borderRight: isResizing ? '2px solid #0066CC' : '1px solid #E5E7EB',
        willChange: isResizing ? 'width' : 'auto'
      }}
    >
      <div className="flex items-center justify-between p-3 border-b border-jj-gray-03 bg-jj-gray-01">
        {isExpanded && searchedKeyword && (
          <div className="text-xs text-jj-gray-07 pr-2">
            <p className="font-johnson-text" style={{ fontWeight: '500' }}>Searched for: "{searchedKeyword}"</p>
            <p className="text-jj-gray-06 mt-1">
              {isMetadataView
                ? `Found ${viewNames.length} source${viewNames.length !== 1 ? 's' : ''}`
                : `Found ${totalRecords.toLocaleString()} records across ${viewNames.length} view${viewNames.length !== 1 ? 's' : ''}`}
            </p>
          </div>
        )}
        <button onClick={onToggle} className="p-2 rounded hover:bg-jj-gray-02 transition-colors ml-auto" aria-label={isExpanded ? "Collapse sidebar" : "Expand sidebar"}>
          <Icon src={isExpanded ? collapseIcon : expandIcon} alt={isExpanded ? "Collapse" : "Expand"} className="w-4 h-4" style={{ filter: 'brightness(0)' }}/>
        </button>
      </div>

      {isExpanded && (
        <div className="p-3 border-b border-jj-gray-03">
          <div className="relative">
            <input type="text" placeholder="Search for views..." value={tabSearchTerm} onChange={(e) => onTabSearchChange(e.target.value)}
              className="w-full pl-8 pr-3 py-2 text-sm border border-jj-gray-03 rounded-md focus:outline-none focus:ring-jj-red focus:border-jj-red" />
            <Icon src={searchIcon} style={{ filter: 'brightness(0)' }} alt="Search" className="absolute left-2.5 top-1/2 transform -translate-y-1/2 w-4 h-4 text-jj-gray-05" />
          </div>
          {filteredTables.length !== viewNames.length && (
            <p className="text-xs text-jj-gray-06 mt-2">Showing {filteredTables.length} of {viewNames.length} tables</p>
          )}
        </div>
      )}

      <div className="flex-1 overflow-y-auto">
        {filteredTables.length === 0 ? (
          isExpanded && <div className="p-4 text-center text-sm text-jj-gray-06">No tables found</div>
        ) : (
          <ul className="space-y-1 p-2">
            {filteredTables.map((tableName) => {
              const recordCount = results[tableName]?.records?.length || 0;
              const isSelected = selectedTable === tableName;

              return (
                <li key={tableName}>
                  <button onClick={() => onTableSelect(tableName)}
                    className={`w-full text-left px-3 py-2 rounded-md transition-all duration-200 flex items-center gap-2 ${
                      isSelected ? 'bg-jj-blue-03 text-white shadow-sm' : 'hover:bg-jj-gray-01 text-jj-gray-08'}`}
                    title={tableName}>
                    <Icon src={dashboardIcon} alt="Table" className="w-4 h-4 flex-shrink-0"
                      style={{ filter: isSelected ? 'brightness(0) invert(1)' : 'brightness(0) saturate(100%) invert(37%) sepia(93%) saturate(1535%) hue-rotate(189deg) brightness(91%) contrast(101%)' }} />
                    {isExpanded && (
                      <>
                        <div className="flex-1 min-w-0">
                          <div className="text-sm font-johnson-text truncate" style={{ fontWeight: '400' }}>{tableName}</div>
                          {isMetadataView && results[tableName]?.database_name && (
                            <div className={`text-xs truncate ${isSelected ? 'text-white/70' : 'text-jj-gray-06'}`}>
                              {results[tableName].database_name}
                            </div>
                          )}
                        </div>
                        <span className={`text-xs font-johnson-text px-2 py-0.5 rounded-full flex-shrink-0 ${
                          isSelected ? 'bg-white/20 text-white' : isMetadataView && results[tableName]?.score ? 'bg-green-100 text-green-800' : 'bg-jj-gray-02 text-jj-gray-07'}`}>
                          {isMetadataView && results[tableName]?.score ? `${results[tableName].score}%` : recordCount}
                        </span>
                      </>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {isExpanded && (
        <div className="p-3 border-t border-jj-gray-03">
          <button className="w-full px-4 py-2 bg-jj-green-03 text-white rounded-md hover:bg-jj-green-05 transition-colors flex items-center justify-center gap-2 font-johnson-text text-sm" onClick={onExport}>
            <Icon src={downloadIcon} alt="Export" className="w-4 h-4" style={{ filter: 'brightness(0) invert(1)' }} />
            <span>{isMetadataView ? 'Export to CSV' : 'Export to Excel'}</span>
          </button>
        </div>
      )}

      {/* Resize Handle */}
      {isExpanded && (
        <div
          className={`absolute top-0 right-0 h-full cursor-col-resize group z-10 flex items-center justify-center transition-colors duration-150 ${
            isResizing ? 'bg-jj-blue-03/10' : 'hover:bg-jj-gray-02/50'
          }`}
          onMouseDown={handleMouseDown}
          style={{
            width: '20px',
            marginRight: '-10px',
            cursor: 'col-resize'
          }}
        >
        </div>
      )}
    </div>
  );
};

// Single Table View Component
const SingleTableView = ({ tableName, tableData, selectedDatasource, onDatasourceChange, datasources, allResults, searchedKeyword }) => {
  const [showMetadata, setShowMetadata] = useState(false);
  const [viewMetadata, setViewMetadata] = useState(null);
  const [metadataError, setMetadataError] = useState("");
  const [isLoadingMetadata, setIsLoadingMetadata] = useState(false);

  const datasourceCounts = useMemo(() => {
    const counts = {};
    let totalCount = 0;
    Object.keys(allResults || {}).forEach((viewName) => {
      const ds = extractDatasource(viewName);
      counts[ds] = (counts[ds] || 0) + 1;
      totalCount++;
    });
    counts['all'] = totalCount;
    return counts;
  }, [allResults]);

  const handleViewMetadata = async () => {
    setShowMetadata(true);
    setIsLoadingMetadata(true);
    setMetadataError("");
    setViewMetadata(null);

    try {
      const metadataArray = await fetchMetadataForView(tableName);
      setViewMetadata(metadataArray.filter(item => item.name === tableName));
    } catch (error) {
      console.error("Error fetching metadata:", error);
      setMetadataError(error.message || "Failed to load metadata");
    } finally {
      setIsLoadingMetadata(false);
    }
  };

  return (
    <div className="flex-1 flex flex-col bg-jj-gray-01 overflow-hidden">
      <div className="bg-white border-b border-jj-gray-03 p-4">
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div className="flex items-center gap-3 flex-wrap">
            <label className="text-xs font-johnson-text text-jj-gray-07 whitespace-nowrap">Data sources:</label>
            <div className="flex items-center gap-1.5 flex-wrap">
              <button onClick={() => onDatasourceChange("all")}
                className={`px-3 py-1.5 rounded-md text-xs font-johnson-text transition-all duration-200 ${
                  selectedDatasource === "all" ? 'bg-jj-blue-03 text-white shadow-sm' : 'bg-jj-gray-01 text-jj-gray-07 hover:bg-jj-gray-02 border border-jj-gray-03'}`}>
                All Sources ({datasourceCounts['all'] || 0})
              </button>
              {datasources.map((ds) => (
                <button key={ds} onClick={() => onDatasourceChange(ds)}
                  className={`px-3 py-1.5 rounded-md text-xs font-johnson-text transition-all duration-200 ${
                    selectedDatasource === ds ? 'bg-jj-blue-03 text-white shadow-sm' : 'bg-jj-gray-01 text-jj-gray-07 hover:bg-jj-gray-02 border border-jj-gray-03'}`}>
                  {ds} ({datasourceCounts[ds] || 0})
                </button>
              ))}
            </div>
          </div>

          <button onClick={handleViewMetadata} disabled={isLoadingMetadata}
            className="flex items-center justify-center gap-2 px-3 py-1.5 bg-jj-blue-03 text-white rounded-md hover:bg-jj-blue-05 disabled:opacity-50 disabled:cursor-not-allowed transition-colors text-xs font-johnson-text whitespace-nowrap">
            {isLoadingMetadata ? (
              <>
                <svg className="w-3.5 h-3.5 animate-spin" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                </svg>
                <span>Loading metadata...</span>
              </>
            ) : (
              <>
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                <span>View Metadata</span>
              </>
            )}
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-auto p-4 space-y-4">
        {showMetadata && <InlineMetadataModal metadata={viewMetadata} loading={isLoadingMetadata} error={metadataError} onClose={() => setShowMetadata(false)} />}

        <div className="bg-white rounded-lg border border-jj-gray-03 p-4">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h2 className="text-xl font-johnson-display text-jj-gray-08">{tableName}</h2>
              <p className="text-sm text-jj-gray-06 mt-1">{tableData.records?.length || 0} records found</p>
            </div>
          </div>

          {/*<div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">*/}
          {/*  <Metric title="Completeness" value={formatPct(tableData.metrics?.completeness)} />*/}
          {/*  <Metric title="Uniqueness" value={formatPct(tableData.metrics?.uniqueness)} />*/}
          {/*  <Metric title="Validity" value={formatPct(tableData.metrics?.validity)} />*/}
          {/*  <Metric title="Consistency" value={formatPct(tableData.metrics?.consistency)} />*/}
          {/*</div>*/}

          <div className="flex items-center justify-between mb-3">
            <h4 className="text-base font-johnson-display text-jj-gray-08">Data preview</h4>
            <p className="text-xs text-jj-gray-06">Click any cell to view full content</p>
          </div>
          <DataTable records={tableData.records || []} searchedKeyword={searchedKeyword} />
        </div>
      </div>
    </div>
  );
};

// Single Metadata View Component
const SingleMetadataView = ({ metadata }) => {
  const [isExpanded, setIsExpanded] = useState(false);

  if (!metadata) {
    return (
      <div className="flex-1 flex items-center justify-center bg-jj-gray-01">
        <div className="text-center">
          <p className="text-jj-gray-06 text-lg">No metadata selected</p>
          <p className="text-sm text-jj-gray-05 mt-2">Select a metadata item from the sidebar</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 bg-jj-gray-01 p-4 overflow-y-auto">
      <div className="max-w-5xl mx-auto">
        <div className="bg-white rounded-lg border border-jj-gray-03 p-6">
          <div className="mb-6">
            <div className="flex items-start justify-between">
              <div className="flex-1">
                <h2 className="text-2xl font-johnson-display text-jj-gray-08 mb-2">{metadata.name || 'Unnamed'}</h2>
                {metadata.id && <p className="text-sm text-jj-gray-05 font-mono">ID: {metadata.id}</p>}
              </div>
              <span className="px-3 py-1 rounded-full text-sm font-johnson-text bg-blue-100 text-blue-800">View</span>
            </div>
          </div>

          {metadata.description && (
            <div className="mb-6 p-4 bg-gray-50 rounded-lg border border-jj-gray-03">
              <h3 className="text-sm font-johnson-text text-jj-gray-08 mb-2">Description</h3>
              <p className="text-sm text-jj-gray-07">{metadata.description}</p>
            </div>
          )}

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
            <div className="p-4 bg-blue-50 rounded-lg border border-blue-200">
              <h4 className="text-xs font-johnson-text text-blue-800 mb-2">Database</h4>
              <p className="text-lg font-johnson-text text-jj-gray-08">{metadata.database_name || 'N/A'}</p>
              <p className="text-xs text-jj-gray-06 mt-1 font-mono">ID: {metadata.database_id || 'N/A'}</p>
            </div>
            <div className="p-4 bg-green-50 rounded-lg border border-green-200">
              <h4 className="text-xs font-johnson-text text-green-800 mb-2">Match Score</h4>
              <p className="text-3xl text-green-700" style={{ fontFamily: 'JohnsonText', fontWeight: '500' }}>{metadata.score || metadata.ranking || 0}%</p>
              <p className="text-xs text-jj-gray-06 mt-1">{metadata.matched_fields || 0} fields matched</p>
            </div>
          </div>

          <div className="grid grid-cols-3 gap-3 mb-6">
            <div className="p-3 bg-yellow-50 rounded-lg border border-yellow-200 text-center">
              <p className="text-xs text-yellow-800 mb-1" style={{ fontFamily: 'JohnsonText', fontWeight: '500' }}>Tagged fields</p>
              <p className="text-2xl text-yellow-700" style={{ fontFamily: 'JohnsonText', fontWeight: '500' }}>{metadata.matched_fields_tagged || 0}</p>
            </div>
            <div className="p-3 bg-purple-50 rounded-lg border border-purple-200 text-center">
              <p className="text-xs text-purple-800 mb-1" style={{ fontFamily: 'JohnsonText', fontWeight: '500' }}>Custom props</p>
              <p className="text-2xl text-purple-700" style={{ fontFamily: 'JohnsonText', fontWeight: '500' }}>{metadata.matched_custom_properties || 0}</p>
            </div>
            <div className="p-3 bg-indigo-50 rounded-lg border border-indigo-200 text-center">
              <p className="text-xs text-indigo-800 mb-1" style={{ fontFamily: 'JohnsonText', fontWeight: '500' }}>Endorsements</p>
              <p className="text-2xl text-indigo-700" style={{ fontFamily: 'JohnsonText', fontWeight: '500' }}>{metadata.countEndorsements || 0}</p>
            </div>
          </div>

          {(metadata.countWarnings > 0 || metadata.countDeprecations > 0) && (
            <div className="flex gap-2 mb-6 flex-wrap">
              {metadata.countWarnings > 0 && (
                <span className="px-3 py-1 bg-orange-100 text-orange-800 rounded-full text-sm font-johnson-text">
                  ⚠️ {metadata.countWarnings} Warning{metadata.countWarnings !== 1 ? 's' : ''}
                </span>
              )}
              {metadata.countDeprecations > 0 && (
                <span className="px-3 py-1 bg-red-100 text-red-800 rounded-full text-sm font-johnson-text">
                  🚫 {metadata.countDeprecations} Deprecation{metadata.countDeprecations !== 1 ? 's' : ''}
                </span>
              )}
            </div>
          )}

          {(metadata.tags?.length > 0 || metadata.categories?.length > 0) && (
            <div className="space-y-3 mb-6">
              {metadata.categories?.length > 0 && (
                <div>
                  <h4 className="text-xs font-johnson-text text-jj-gray-07 mb-2">Categories</h4>
                  <div className="flex flex-wrap gap-2">
                    {metadata.categories.map((cat, idx) => (
                      <span key={idx} className="px-3 py-1 bg-green-100 text-green-800 rounded-full text-sm font-johnson-text">
                        {typeof cat === 'string' ? cat : cat.name}
                      </span>
                    ))}
                  </div>
                </div>
              )}
              {metadata.tags?.length > 0 && (
                <div>
                  <h4 className="text-xs font-johnson-text text-jj-gray-07 mb-2">Tags</h4>
                  <div className="flex flex-wrap gap-2">
                    {metadata.tags.map((tag, idx) => (
                      <span key={idx} className="px-3 py-1 bg-blue-100 text-blue-800 rounded-full text-sm font-johnson-text">
                        {typeof tag === 'string' ? tag : tag.name}
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {(metadata.lastModificationVdpData || metadata.lastModificationIsstData) && (
            <div className="text-xs text-jj-gray-06 space-y-1 p-3 bg-jj-gray-01 rounded-lg mb-4">
              {metadata.lastModificationVdpData && <p>Last Modified (VDP): {new Date(metadata.lastModificationVdpData).toLocaleString()}</p>}
              {metadata.lastModificationIsstData && <p>Last Modified (ISST): {new Date(metadata.lastModificationIsstData).toLocaleString()}</p>}
            </div>
          )}

          <button onClick={() => setIsExpanded(!isExpanded)} className="text-sm text-jj-blue-03 hover:text-jj-blue-05 font-johnson-text flex items-center gap-1" style={{ fontWeight: '500' }}>
            <span>{isExpanded ? '▼' : '▶'}</span>
            <span>{isExpanded ? 'Hide' : 'Show'} Full Details</span>
          </button>

          {isExpanded && (
            <div className="mt-4 p-4 bg-jj-gray-08 rounded-lg text-xs text-white font-mono overflow-x-auto max-h-96 overflow-y-auto">
              <pre>{JSON.stringify(metadata, null, 2)}</pre>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

// Metadata Display Component
// Main Component
export default function GRADataHubFuzzyPage() {
  const { credentials } = useAuth();
  const { hasPermission } = useRBAC();
  const searchHook = useSearch();
  const metadataHook = useMetadata();

  const [sidebarExpanded, setSidebarExpanded] = useState(true);
  const [sidebarWidth, setSidebarWidth] = useState(320); // Default width in pixels
  const [selectedTable, setSelectedTable] = useState(null);
  const [selectedDatasource, setSelectedDatasource] = useState("all");
  const [tabSearchTerm, setTabSearchTerm] = useState("");
  const [downloadLoading, setDownloadLoading] = useState(false);
  const [showDownloadModal, setShowDownloadModal] = useState(false);
  const [downloadProgress, setDownloadProgress] = useState(null);
  const [selectedMetadata, setSelectedMetadata] = useState(null);
  const [metadataDownloadLoading, setMetadataDownloadLoading] = useState(false);

  const datasources = useMemo(() => {
    const viewNames = Object.keys(searchHook.results || {});
    const sources = new Set(viewNames.map(extractDatasource));
    return Array.from(sources).sort();
  }, [searchHook.results]);

  const filteredResults = useMemo(() => {
    if (selectedDatasource === "all") return searchHook.results;
    const filtered = {};
    Object.keys(searchHook.results).forEach((viewName) => {
      if (extractDatasource(viewName) === selectedDatasource) {
        filtered[viewName] = searchHook.results[viewName];
      }
    });
    return filtered;
  }, [searchHook.results, selectedDatasource]);

  useEffect(() => {
    const viewNames = Object.keys(filteredResults);
    if (viewNames.length > 0 && !selectedTable) {
      setSelectedTable(viewNames[0]);
    } else if (viewNames.length === 0) {
      setSelectedTable(null);
    }
  }, [filteredResults, selectedTable]);

  useEffect(() => {
    if (metadataHook.metadataResults.length > 0 && !selectedMetadata) {
      setSelectedMetadata(metadataHook.metadataResults[0]);
    } else if (metadataHook.metadataResults.length === 0) {
      setSelectedMetadata(null);
    setTabSearchTerm(""); // Clear sidebar filter on reset
    }
  }, [metadataHook.metadataResults, selectedMetadata]);

  // Reset sidebar width when new search is performed
  useEffect(() => {
    setSidebarWidth(320); // Reset to default width
  }, [searchHook.lastSearchedTerm, metadataHook.lastMetadataSearchTerm]);

  // Clear sidebar filter when new search is performed
  useEffect(() => {
    setTabSearchTerm("");
  }, [searchHook.lastSearchedTerm, metadataHook.lastMetadataSearchTerm]);

  const handleReset = () => {
    searchHook.resetSearch();
    metadataHook.resetMetadata();
    setSelectedTable(null);
    setSelectedMetadata(null);
    setTabSearchTerm(""); // Clear sidebar filter on reset
  };

  const handleDownload = async (includeMetadata) => {
    setShowDownloadModal(false);
    setDownloadProgress(null);

    await downloadExcel(
      searchHook.results,
      setDownloadLoading,
      () => {},
      includeMetadata,
      (progressInfo) => {
        setDownloadProgress(progressInfo);
        setShowDownloadModal(true);
      }
    );

    setTimeout(() => {
      setShowDownloadModal(false);
      setDownloadProgress(null);
    }, 1500);
  };

  const handleMetadataExport = async () => {
    setDownloadProgress({ stage: 'metadata', current: 0, total: 1, message: 'Preparing metadata export...' });
    setShowDownloadModal(true);
    setMetadataDownloadLoading(true);

    try {
      const onProgress = (progressInfo) => {
        setDownloadProgress(progressInfo);
      };

      await new Promise(resolve => setTimeout(resolve, 300)); // Brief delay for UX

      onProgress({ stage: 'excel', current: 1, total: 1, message: 'Generating CSV file...' });

      // Create CSV content
      const csv = [
        ['Name', 'Database', 'Score', 'Matched Fields', 'Tagged Fields', 'Custom Properties', 'Endorsements', 'Warnings', 'Deprecations', 'Categories', 'Tags', 'Description'].join(','),
        ...metadataHook.metadataResults.map(m => [
          `"${m.name || ''}"`, `"${m.database_name || ''}"`, m.score || 0, m.matched_fields || 0, m.matched_fields_tagged || 0,
          m.matched_custom_properties || 0, m.countEndorsements || 0, m.countWarnings || 0, m.countDeprecations || 0,
          `"${(m.categories || []).map(c => typeof c === 'string' ? c : c.name).join('; ')}"`,
          `"${(m.tags || []).map(t => typeof t === 'string' ? t : t.name).join('; ')}"`,
          `"${(m.description || '').replace(/"/g, '""')}"`
        ].join(','))
      ].join('\n');

      await new Promise(resolve => setTimeout(resolve, 200)); // Brief delay for UX

      const blob = new Blob([csv], { type: 'text/csv' });
      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      link.download = `metadata_results_${new Date().toISOString().split('T')[0]}.csv`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(link.href);

      onProgress({ stage: 'complete', current: 1, total: 1, message: 'Download complete!' });
    } catch (err) {
      console.error('Download error:', err);
    } finally {
      setMetadataDownloadLoading(false);
      setTimeout(() => {
        setShowDownloadModal(false);
        setDownloadProgress(null);
      }, 1500);
    }
  };

  const showingDataResults = searchHook.searchPerformed && Object.keys(searchHook.results).length > 0;
  const showingMetadataResults = metadataHook.metadataSearchPerformed;

  if (!showingDataResults && !showingMetadataResults) {
    return (
      <div className="bg-gradient-to-br from-jj-gray-01 via-white to-jj-gray-02 min-h-full flex items-center justify-center p-8">
        <div className="w-full max-w-4xl">
          <div className="text-center mb-8">
            <h1 className="text-4xl font-johnson-display text-jj-gray-08 mb-3" style={{ lineHeight: '110%' }}>Fuzzy Search</h1>
            <p className="text-md text-jj-gray-06 font-johnson-text" style={{ lineHeight: '120%' }}>Search across different databases with powerful fuzzy matching</p>
          </div>

          <form onSubmit={(e) => e.preventDefault()} className="space-y-6">
              <div className="flex gap-3">
                <input type="text" placeholder="Enter search term (e.g., customer or customer~0.8 for fuzzy search)"
                  value={searchHook.searchText} onChange={(e) => searchHook.setSearchText(e.target.value)}
                  className="flex-1 px-4 py-3 text-base border border-jj-gray-03 rounded-lg focus:outline-none focus:border-jj-red focus:border-1 transition-all"
                  disabled={searchHook.loading || metadataHook.metadataLoading} autoComplete="off" autoFocus />
              </div>

              {/* Advanced Filter - Datasource Selection */}
              <div className="bg-jj-gray-01 border border-jj-gray-03 rounded-lg p-4">
                <div className="flex items-center justify-between mb-3">
                  <label className="text-sm font-johnson-text text-jj-gray-08" style={{ fontWeight: '400' }}>
                    Filter by data source:
                  </label>
                </div>
                <div className="flex flex-wrap gap-2">
                  <button
                    key="all"
                    type="button"
                    onClick={() => searchHook.setDatasourceFilter([])}
                    className={`px-4 py-2 rounded-lg font-johnson-text text-sm transition-all duration-200 ${
                      searchHook.datasourceFilter.length === 0
                        ? 'bg-jj-blue-03 hover:bg-jj-blue-05 text-white shadow-lg'
                        : 'bg-jj-gray-03 text-jj-gray-07 hover:bg-jj-gray-04'
                    }`}
                    disabled={searchHook.loading || metadataHook.metadataLoading}
                  >
                    All sources
                    {searchHook.datasourceFilter.length === 0 && (
                      <svg className="inline-block ml-1 w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
                        <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                      </svg>
                    )}
                  </button>
                  {[
                    { value: 'grail', label: 'GRAIL' },
                    { value: 'insight', label: 'Insight' },
                    { value: 'insight7', label: 'Insight7' },
                    { value: 'lift', label: 'LIFT' },
                    { value: 'rimdocs', label: 'RIMDocs' },
                    { value: 'urp', label: 'URP' }
                  ].map((source) => {
                    const isSelected = searchHook.datasourceFilter.includes(source.value);
                    return (
                      <button
                        key={source.value}
                        type="button"
                        onClick={() => {
                          if (isSelected) {
                            // Remove from array
                            searchHook.setDatasourceFilter(
                              searchHook.datasourceFilter.filter(ds => ds !== source.value)
                            );
                          } else {
                            // Add to array
                            searchHook.setDatasourceFilter([...searchHook.datasourceFilter, source.value]);
                          }
                        }}
                        className={`px-4 py-2 rounded-lg font-johnson-text text-sm transition-all duration-200 ${
                          isSelected
                            ? 'bg-jj-blue-03 hover:bg-jj-blue-05 text-white shadow-lg'
                            : 'bg-jj-gray-03 text-jj-gray-07 hover:bg-jj-gray-04'
                        }`}
                        disabled={searchHook.loading || metadataHook.metadataLoading}
                      >
                        {source.label}
                        {isSelected && (
                          <svg className="inline-block ml-1 w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
                            <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                          </svg>
                        )}
                      </button>
                    );
                  })}
                </div>
                {searchHook.datasourceFilter.length > 0 && (
                  <div className="mt-2 text-xs text-jj-gray-06 font-johnson-text">
                    <svg className="inline-block w-3 h-3 mr-1" fill="currentColor" viewBox="0 0 20 20">
                      <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z" clipRule="evenodd" />
                    </svg>
                    Searching in: {searchHook.datasourceFilter.map(ds => ds.toUpperCase()).join(', ')}
                  </div>
                )}
              </div>

              <div className="flex items-center justify-center gap-4">
                {hasPermission('viewData') && (
                  <button type="button" onClick={searchHook.handleSearch}
                    className="px-8 py-3 bg-jj-blue-03 text-white rounded-lg hover:bg-jj-blue-05 disabled:opacity-50 disabled:cursor-not-allowed transition-all duration-200 flex items-center justify-center gap-2 font-johnson-text shadow-md hover:shadow-lg"
                    disabled={searchHook.loading || metadataHook.metadataLoading || !searchHook.searchText.trim()}>
                    {searchHook.loading ? (
                      <>
                        <div className="animate-spin"><Icon src={searchIcon} alt="Loading" className="w-5 h-5" style={{ filter: 'brightness(0) invert(1)' }} /></div>
                        <span>Searching Data...</span>
                      </>
                    ) : (
                      <>
                        <Icon src={searchIcon} alt="Search" className="w-5 h-5" style={{ filter: 'brightness(0) invert(1)' }} />
                        <span>Search Data</span>
                      </>
                    )}
                  </button>
                )}

                {hasPermission('viewMetadata') && (
                  <button type="button" onClick={() => metadataHook.fetchMetadata(searchHook.searchText.trim(), {}, searchHook.datasourceFilter)}
                    className="px-6 py-3 bg-jj-green-03 text-white rounded-lg hover:bg-jj-green-05 disabled:opacity-50 disabled:cursor-not-allowed transition-colors duration-200 flex items-center gap-2 font-johnson-text shadow-md hover:shadow-lg"
                    disabled={metadataHook.metadataLoading || searchHook.loading || !searchHook.searchText.trim()}>
                    {metadataHook.metadataLoading ? (
                      <>
                        <div className="animate-spin">
                          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                          </svg>
                        </div>
                        <span>Searching Metadata...</span>
                      </>
                    ) : (
                      <>
                        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                        </svg>
                        <span>Search Metadata</span>
                      </>
                    )}
                  </button>
                )}
              </div>

              {searchHook.loading && <div className="flex justify-center"><LoadingSpinner /></div>}

              {searchHook.error && (
                <div className="text-jj-red text-sm bg-red-50 p-3 rounded-lg border border-red-200 text-center" role="alert">{searchHook.error}</div>
              )}

              {metadataHook.metadataError && (
                <div className="text-jj-red text-sm bg-red-50 p-3 rounded-lg border border-red-200 text-center" role="alert">{metadataHook.metadataError}</div>
              )}
              {/* No results found message */}
              {searchHook.searchPerformed && Object.keys(searchHook.results).length === 0 && !searchHook.loading && !searchHook.error && (
                <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-6 text-center">
                  <div className="w-16 h-16 bg-yellow-100 rounded-full flex items-center justify-center mx-auto mb-4">
                    <svg className="w-8 h-8 text-yellow-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.172 16.172a4 4 0 015.656 0M9 10h.01M15 10h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                    </svg>
                  </div>
                  <h3 className="text-xl font-johnson-display text-jj-gray-08 mb-2" style={{ lineHeight: '110%' }}>
                    No results found
                  </h3>
                  <p className="text-jj-gray-06 font-johnson-text mb-4" style={{ lineHeight: '120%' }}>
                    No data found for "{searchHook.lastSearchedTerm}". Try adjusting your search term or use fuzzy matching (e.g., "customer~0.8").
                  </p>
                </div>
              )}

              {metadataHook.metadataSearchPerformed && metadataHook.metadataResults.length === 0 && !metadataHook.metadataLoading && !metadataHook.metadataError && (
                <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-6 text-center">
                  <div className="w-16 h-16 bg-yellow-100 rounded-full flex items-center justify-center mx-auto mb-4">
                    <svg className="w-8 h-8 text-yellow-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.172 16.172a4 4 0 015.656 0M9 10h.01M15 10h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                    </svg>
                  </div>
                  <h3 className="text-xl font-johnson-display text-jj-gray-08 mb-2" style={{ lineHeight: '110%' }}>
                    No metadata found
                  </h3>
                  <p className="text-jj-gray-06 font-johnson-text mb-4" style={{ lineHeight: '120%' }}>
                    No metadata found for "{metadataHook.lastMetadataSearchTerm}". The view may not be registered in the catalog.
                  </p>
                </div>
              )}
            </form>

            <div className="mt-12 grid grid-cols-1 md:grid-cols-3 gap-6 text-center">
              <div className="p-4">
                <div className="w-12 h-12 bg-jj-blue-03 rounded-full flex items-center justify-center mx-auto mb-3">
                  <Icon src={searchIcon} alt="Search" className="w-6 h-6" style={{ filter: 'brightness(0) invert(1)' }} />
                </div>
                <h3 className="font-johnson-display text-jj-gray-08 mb-2" style={{ lineHeight: '110%' }}>Multi-database search</h3>
                <p className="text-sm text-jj-gray-06 font-johnson-text" style={{ lineHeight: '120%' }}>Query across all connected databases simultaneously</p>
              </div>
              <div className="p-4">
                <div className="w-12 h-12 bg-jj-green-03 rounded-full flex items-center justify-center mx-auto mb-3">
                  <svg className="w-6 h-6 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                </div>
                <h3 className="font-johnson-display text-jj-gray-08 mb-2" style={{ lineHeight: '110%' }}>Fuzzy matching</h3>
                <p className="text-sm text-jj-gray-06" style={{ lineHeight: '120%' }}>Find results even with typos or partial matches</p>
              </div>
              <div className="p-4">
                <div className="w-12 h-12 bg-jj-red rounded-full flex items-center justify-center mx-auto mb-3">
                  <Icon src={downloadIcon} alt="Download" className="w-6 h-6" style={{ filter: 'brightness(0) invert(1)' }} />
                </div>
                <h3 className="font-johnson-display text-jj-gray-08 mb-2" style={{ lineHeight: '110%' }}>Export results</h3>
                <p className="text-sm text-jj-gray-06" style={{ lineHeight: '120%' }}>Download search results with metadata to Excel</p>
              </div>
            </div>
          </div>
        </div>
    );
  }

  if (showingDataResults) {
    return (
      <div className="h-full bg-jj-gray-01 flex flex-col">
        <div className="bg-white border-b border-jj-gray-03 shadow-sm flex-shrink-0">
          <div className="w-full px-4 py-3 lg:px-6 xl:px-8">
            <div className="flex items-center justify-between">
              <h1 className="text-2xl font-johnson-display text-jj-gray-08">Fuzzy Search</h1>
              <button onClick={handleReset} className="px-4 py-2 bg-jj-gray-02 text-jj-gray-08 rounded-lg hover:bg-jj-gray-03 transition-colors flex items-center gap-2 text-sm font-johnson-text">
                <Icon src={reset} alt="Reset" className="w-4 h-4" />
                <span>New search</span>
              </button>
            </div>
          </div>
        </div>

        <div className="flex flex-1 overflow-hidden">
          <ResultsSidebar results={filteredResults} selectedTable={selectedTable} onTableSelect={setSelectedTable}
            isExpanded={sidebarExpanded} onToggle={() => setSidebarExpanded(!sidebarExpanded)}
            tabSearchTerm={tabSearchTerm} onTabSearchChange={setTabSearchTerm}
            onExport={() => { setDownloadProgress(null); setShowDownloadModal(true); }}
            searchedKeyword={searchHook.lastSearchedTerm || searchHook.searchText}
            sidebarWidth={sidebarWidth} setSidebarWidth={setSidebarWidth} />

          {selectedTable && filteredResults[selectedTable] ? (
            <SingleTableView tableName={selectedTable} tableData={filteredResults[selectedTable]}
              selectedDatasource={selectedDatasource}
              onDatasourceChange={(ds) => { setSelectedDatasource(ds); setSelectedTable(null); }}
              datasources={datasources} allResults={searchHook.results}
              searchedKeyword={searchHook.lastSearchedTerm || searchHook.searchText} />
          ) : (
            <div className="flex-1 flex items-center justify-center bg-jj-gray-01">
              <div className="text-center">
                <p className="text-jj-gray-06 text-lg">No table selected</p>
                <p className="text-sm text-jj-gray-05 mt-2">Select a table from the sidebar to view its data</p>
              </div>
            </div>
          )}
        </div>

        {showDownloadModal && (
          <DownloadOptionsModal onClose={() => setShowDownloadModal(false)} onDownload={handleDownload}
            loading={downloadLoading || metadataDownloadLoading} progress={downloadProgress} />
        )}
      </div>
    );
  }

  if (showingMetadataResults) {
    const metadataResultsForSidebar = {};
    metadataHook.metadataResults.forEach((metadata, index) => {
      const key = metadata.name || `metadata_${index}`;
      metadataResultsForSidebar[key] = { ...metadata, records: [] };
    });

    const metadataViewNames = Object.keys(metadataResultsForSidebar);
    const selectedMetadataKey = selectedMetadata?.name || (metadataViewNames.length > 0 ? metadataViewNames[0] : null);

    return (
      <div className="h-full bg-jj-gray-01 flex flex-col">
        <div className="bg-white border-b border-jj-gray-03 shadow-sm flex-shrink-0">
          <div className="w-full px-4 py-3 lg:px-6 xl:px-8">
            <div className="flex items-center justify-between">
              <h1 className="text-2xl font-johnson-display text-jj-gray-08">Fuzzy Search</h1>
              <button onClick={handleReset} className="px-4 py-2 bg-jj-gray-02 text-jj-gray-08 rounded-lg hover:bg-jj-gray-03 transition-colors flex items-center gap-2 text-sm font-johnson-text">
                <Icon src={reset} alt="Reset" className="w-4 h-4" />
                <span>New search</span>
              </button>
            </div>
          </div>
        </div>

        <div className="flex flex-1 overflow-hidden">
          <ResultsSidebar results={metadataResultsForSidebar} selectedTable={selectedMetadataKey}
            onTableSelect={(key) => setSelectedMetadata(metadataResultsForSidebar[key])}
            isExpanded={sidebarExpanded} onToggle={() => setSidebarExpanded(!sidebarExpanded)}
            tabSearchTerm={tabSearchTerm} onTabSearchChange={setTabSearchTerm}
            onExport={handleMetadataExport}
            searchedKeyword={metadataHook.lastMetadataSearchTerm} isMetadataView={true}
            sidebarWidth={sidebarWidth} setSidebarWidth={setSidebarWidth} />

          <SingleMetadataView metadata={selectedMetadata} />
        </div>

        {/* Download Progress Modal */}
        {showDownloadModal && (
          <DownloadOptionsModal onClose={() => setShowDownloadModal(false)} onDownload={handleDownload}
            loading={downloadLoading || metadataDownloadLoading} progress={downloadProgress} />
        )}
      </div>
    );
  }

  return null;
}