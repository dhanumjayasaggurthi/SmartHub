import React, { useState, useMemo, useEffect, useCallback, useRef, memo } from 'react';
import LoadingSpinner from './components/LoadingSpinner';
import { useRBAC } from '../context/RBACContext';

// J&J Custom Icons
import checkCircleIcon from "/icons/JJ_Icon_Check_RGB.svg";
import alertTriangleIcon from "/icons/JJ_Icon_Alert_RGB.svg";
import xCircleIcon from "/icons/JJ_Icon_Close.svg";
import searchIcon from "/icons/JJ_Icon_Search_RGB.svg";
import databaseIcon from "/icons/JJ_Icon_Database_RGB.svg";
import minusIcon from "/icons/JJ_Icon_Remove.svg";
import barChartIcon from "/icons/JJ_Icon_Graph_Chart_RGB.svg";
import shieldCheckIcon from "/icons/JJ_Icon_Safety.svg";
import activityIcon from "/icons/JJIM_Icon_Fingernail.svg";
import clockIcon from "/icons/JJ_Icon_Timer_RGB.svg";
import chevronDownIcon from "/icons/JJ_Icon_Chevron_Down.svg";
import chevronRightIcon from "/icons/JJ_Icon_Chevron_Right.svg";
import infoIcon from "/icons/JJ_Icon_Info_RGB.svg";
import chevronLeftIcon from "/icons/JJ_Icon_Chevron_Left.svg";
import refreshIcon from "/icons/JJ_Icon_Refresh_RGB.svg";
import { apiFetch } from '../utils/apiClient';

// Icon component wrapper for J&J icons with Lucide-matching color support
// Applies CSS filters to match J&J brand colors exactly as Lucide icons did
const Icon = ({ src, alt, className = "w-6 h-6", color }) => {
  // Color filter mapping to match J&J brand colors
  const getColorFilter = (colorClass) => {
    if (!colorClass) return {};

    // Extract color from className or use color prop
    const colorToMatch = color || colorClass;

    if (colorToMatch.includes('jj-green-03') || colorToMatch.includes('text-green')) {
      // J&J Green (#328714)
      return { filter: 'brightness(0) saturate(100%) invert(37%) sepia(87%) saturate(1158%) hue-rotate(71deg) brightness(91%) contrast(93%)' };
    }
    if (colorToMatch.includes('jj-maroon-05') || colorToMatch.includes('text-red')) {
      // J&J Maroon (#9e0000)
      return { filter: 'brightness(0) saturate(100%) invert(13%) sepia(97%) saturate(6477%) hue-rotate(359deg) brightness(91%) contrast(99%)' };
    }
    if (colorToMatch.includes('jj-orange-03')) {
      // J&J Orange (#ff6017)
      return { filter: 'brightness(0) saturate(100%) invert(48%) sepia(97%) saturate(2446%) hue-rotate(347deg) brightness(102%) contrast(105%)' };
    }
    if (colorToMatch.includes('jj-blue-03')) {
      // J&J Blue (#0f68b2)
      return { filter: 'brightness(0) saturate(100%) invert(37%) sepia(93%) saturate(1535%) hue-rotate(189deg) brightness(91%) contrast(101%)' };
    }
    if (colorToMatch.includes('jj-red')) {
      // J&J Red (#eb1700)
      return { filter: 'brightness(0) saturate(100%) invert(17%) sepia(100%) saturate(7426%) hue-rotate(3deg) brightness(92%) contrast(118%)' };
    }
    if (colorToMatch.includes('jj-gray-08')) {
      // J&J Dark Gray (#312c2a)
      return { filter: 'brightness(0) saturate(100%) invert(15%) sepia(7%) saturate(806%) hue-rotate(346deg) brightness(95%) contrast(89%)' };
    }
    if (colorToMatch.includes('jj-gray-06')) {
      // J&J Medium Gray (#81766f)
      return { filter: 'brightness(0) saturate(100%) invert(50%) sepia(6%) saturate(656%) hue-rotate(346deg) brightness(92%) contrast(88%)' };
    }
    if (colorToMatch.includes('jj-gray-05')) {
      // J&J Gray (#a39992)
      return { filter: 'brightness(0) saturate(100%) invert(65%) sepia(6%) saturate(556%) hue-rotate(346deg) brightness(92%) contrast(88%)' };
    }
    if (colorToMatch.includes('jj-gray-04')) {
      // J&J Light Gray (#cbc4bc)
      return { filter: 'brightness(0) saturate(100%) invert(82%) sepia(6%) saturate(356%) hue-rotate(346deg) brightness(92%) contrast(88%)' };
    }
    if (colorToMatch.includes('white') || colorToMatch.includes('invert')) {
      // White
      return { filter: 'brightness(0) invert(1)' };
    }

    return {};
  };

  const filterStyle = getColorFilter(className);

  return (
    <img
      src={src}
      alt={alt}
      className={className}
      style={filterStyle}
    />
  );
};

// Environment configuration
const API_BASE_URL = import.meta.env.VITE_APII_BASE_URL;

// Status constants
const STATUS = {
  PASSED: 'PASSED',
  CRITICAL: 'CRITICAL',
  ERROR: 'ERROR',
  MATCH: 'MATCH',
  MISMATCH: 'MISMATCH',
  DEFINITION_MISMATCH: 'DEFINITION_MISMATCH',
  NONE: 'NONE',
  FAULTY: 'FAULTY',
  TIMEOUT: 'TIMEOUT',
  TABLE_NOT_FOUND: 'TABLE_NOT_FOUND',
  ALL: 'ALL'
};

// Common className constants
const CLASSNAMES = {
  tableHeader: "px-4 py-3 text-center text-xs font-johnson-text text-jj-gray-08 bg-gradient-to-r from-jj-gray-01 to-jj-gray-02",
  tableHeaderLeft: "px-4 py-3 text-left text-xs font-johnson-text text-jj-gray-08 bg-gradient-to-r from-jj-gray-01 to-jj-gray-02",
  tableCell: "px-4 py-3 text-center align-middle font-johnson-text",
  tableCellBold: "px-4 py-3 text-center text-xs align-middle font-johnson-text text-jj-gray-08"
};


// Toast Notification Component
const Toast = memo(({ message, type = 'success', onClose }) => {
  useEffect(() => {
    const timer = setTimeout(onClose, 5000);
    return () => clearTimeout(timer);
  }, [onClose]);

  const bgColor = type === 'success' ? 'bg-jj-green-03' : type === 'error' ? 'bg-jj-maroon-05' : 'bg-jj-blue-03';
  const iconSrc = type === 'success' ? checkCircleIcon : type === 'error' ? xCircleIcon : infoIcon;

  return (
    <div className="fixed top-6 right-6 z-50 animate-slide-in">
      <div className={`${bgColor} text-white px-6 py-4 rounded-xl shadow-2xl flex items-center gap-3 min-w-[300px] max-w-md`}>
        <Icon src={iconSrc} alt={type} className="w-6 h-6 flex-shrink-0 text-white" />
        <p className="font-johnson-text text-sm font-medium flex-1">{message}</p>
        <button onClick={onClose} className="hover:opacity-70 transition-opacity">
          <Icon src={xCircleIcon} alt="Close" className="w-5 h-5 text-white" />
        </button>
      </div>
      <style jsx>{`
        @keyframes slide-in {
          from {
            transform: translateX(100%);
            opacity: 0;
          }
          to {
            transform: translateX(0);
            opacity: 1;
          }
        }
        .animate-slide-in {
          animation: slide-in 0.3s ease-out;
        }
      `}</style>
    </div>
  );
});
Toast.displayName = 'Toast';
// Error Boundary Component
class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, errorInfo) {
    console.error('DQEngine Error:', error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen flex items-center justify-center bg-gradient-to-r from-jj-gray-01 to-jj-gray-02 p-6">
          <div className="bg-white rounded-xl shadow-xl p-8 max-w-2xl">
            <div className="flex items-center gap-4 mb-4">
              <Icon src={alertTriangleIcon} alt="Error" className="w-12 h-12 text-jj-maroon-05" />
              <div>
                <h2 className="text-2xl text-jj-gray-08 font-johnson-display" style={{ lineHeight: '110%' }}>
                  Something went wrong
                </h2>
                <p className="text-sm text-jj-gray-06 font-johnson-text">
                  An unexpected error occurred while loading the data quality platform
                </p>
              </div>
            </div>
            <button
              onClick={() => window.location.reload()}
              className="w-full py-3 px-6 rounded-lg font-bold bg-jj-red text-white hover:bg-jj-maroon-05 transition-all duration-300"
            >
              Reload Page
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

// Helper to normalize new flat API response into consistent shape for components
const normalizeTable = (table) => {
  const isNotFound = table.status === 'TABLE_NOT_FOUND';
  const hasTypeMismatch = !isNotFound && (table.column_statistics || []).some(
    col => col.l0_type && col.l1_type && col.l0_type !== col.l1_type
  );
  return {
  ...table,
  table_name: table.l0_table || 'Unknown',
  snowflake_table: table.l1_table || 'Unknown',
  status: hasTypeMismatch && !['CRITICAL', 'FAULTY'].includes(table.status) ? 'FAULTY' : (table.status || 'Unknown'),
  validation_issues: [
    ...(table.validation_issues || []),
    ...(isNotFound && table.error ? [table.error] : []),
    ...(hasTypeMismatch && !['CRITICAL', 'FAULTY'].includes(table.status)
      ? ['Table marked FAULTY due to column type mismatches between L0 and L1']
      : [])
  ],
  row_counts: isNotFound ? { oracle: 0, snowflake: 0, match: false } : {
    oracle: table.row_counts?.l0 ?? 0,
    snowflake: table.row_counts?.l1 ?? 0,
    match: table.row_counts?.match ?? false,
  },
  data_quality: isNotFound ? null : table.data_quality ? {
    oracle_nulls: table.data_quality.l0_nulls,
    snowflake_nulls: table.data_quality.l1_nulls,
    oracle_duplicates: table.data_quality.l0_duplicates,
    snowflake_duplicates: table.data_quality.l1_duplicates,
    null_match: table.data_quality.null_match,
    duplicate_match: table.data_quality.duplicate_match,
  } : null,
  ...(!isNotFound && {
  column_analysis: table.column_analysis ? {
    oracle_columns: table.column_analysis.l0_columns,
    snowflake_columns: table.column_analysis.l1_columns,
    common_columns: table.column_analysis.common_columns,
    oracle_only_columns: table.column_analysis.l0_only_columns,
    snowflake_only_columns: table.column_analysis.l1_only_columns,
  } : null,
  column_statistics: (table.column_statistics || []).map(col => ({
    ...col,
    oracle_type: col.l0_type,
    snowflake_type: col.l1_type,
    oracle_stats: col.l0_stats,
    snowflake_stats: col.l1_stats,
  })),
  }),
  constraint_analysis: !isNotFound && table.constraint_analysis ? {
    ...table.constraint_analysis,
    // Normalize constraint_warnings: object → array of strings
    constraint_warnings: Object.entries(table.constraint_analysis.constraint_warnings || {})
      .map(([k, v]) => `${k}: ${v}`),
    // not_null detail field rename
    validation_results: table.constraint_analysis.validation_results ? {
      ...table.constraint_analysis.validation_results,
      not_null_constraints: table.constraint_analysis.validation_results.not_null_constraints ? {
        ...table.constraint_analysis.validation_results.not_null_constraints,
        details: (table.constraint_analysis.validation_results.not_null_constraints.details || []).map(d => ({
          ...d,
          snowflake_null_count: d.l1_null_count,
        })),
      } : undefined,
    } : undefined,
  } : null,
  };
};

// Helper function to format timestamp
const formatTimestamp = (timestamp) => {
  if (!timestamp) return '';
  try {
    const date = new Date(timestamp);
    return date.toLocaleString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: true
    });
  } catch (e) {
    return timestamp;
  }
};

// PERFORMANCE: Memoized Summary Card Component
const SummaryCard = memo(({ title, value, icon, colorClass = 'text-jj-gray-08', accentClass = 'bg-jj-gray-04' }) => (
  <div className="relative bg-white rounded-2xl overflow-hidden border border-jj-gray-02 hover:shadow-lg transition-all duration-200 group">
    <div className={`absolute top-0 left-0 right-0 h-0.5 ${accentClass}`} />
    <div className="px-5 pt-5 pb-4">
      <div className="flex items-center justify-between mb-3">
        <span className="font-johnson-text text-xs font-bold uppercase tracking-wider text-jj-gray-05">{title}</span>
        <div className="w-8 h-8 rounded-lg bg-jj-gray-01 flex items-center justify-center group-hover:scale-110 transition-transform duration-200">
          <Icon src={icon} alt={title} className={`w-4 h-4 ${colorClass}`} />
        </div>
      </div>
      <p className={`font-johnson-display text-3xl font-bold ${colorClass}`} style={{ lineHeight: '1' }}>
        {typeof value === 'number' ? value.toLocaleString() : value}
      </p>
    </div>
  </div>
));
SummaryCard.displayName = 'SummaryCard';

// PERFORMANCE: Memoized Status Badge Component
const StatusBadge = memo(({ status }) => {
  const getStatusConfig = () => {
    switch (status) {
      case STATUS.PASSED:
        return { colorClass: 'text-jj-green-03', bgClass: 'bg-green-50', icon: checkCircleIcon, text: 'Passed' };
      case STATUS.CRITICAL:
        return { colorClass: 'text-jj-maroon-05', bgClass: 'bg-red-50', icon: xCircleIcon, text: 'Critical' };
      case STATUS.ERROR:
        return { colorClass: 'text-jj-maroon-05', bgClass: 'bg-red-50', icon: xCircleIcon, text: 'Error' };
      case STATUS.MATCH:
        return { colorClass: 'text-jj-green-03', bgClass: 'bg-green-50', icon: checkCircleIcon, text: 'Match' };
      case STATUS.MISMATCH:
        return { colorClass: 'text-jj-maroon-05', bgClass: 'bg-red-50', icon: xCircleIcon, text: 'Mismatch' };
      case STATUS.DEFINITION_MISMATCH:
        return { colorClass: 'text-jj-orange-03', bgClass: 'bg-orange-50', icon: alertTriangleIcon, text: 'Definition Mismatch' };
      case STATUS.NONE:
        return { colorClass: 'text-jj-gray-06', bgClass: 'bg-jj-gray-02', icon: minusIcon, text: 'None' };
      case STATUS.FAULTY:
        return { colorClass: 'text-jj-orange-03', bgClass: 'bg-orange-50', icon: alertTriangleIcon, text: 'Faulty' };
      case STATUS.TIMEOUT:
        return { colorClass: 'text-jj-orange-03', bgClass: 'bg-orange-50', icon: clockIcon, text: 'Timeout' };
      case STATUS.TABLE_NOT_FOUND:
        return { colorClass: 'text-jj-gray-06', bgClass: 'bg-jj-gray-02', icon: alertTriangleIcon, text: 'Not Found' };
      default:
        return { colorClass: 'text-jj-gray-06', bgClass: 'bg-jj-gray-02', icon: minusIcon, text: status || 'Unknown' };
    }
  };

  const config = getStatusConfig();

  return (
    <span className={`inline-flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-johnson-text will-change-transform transition-all duration-300 hover:scale-105 ${config.colorClass} ${config.bgClass} shadow-md`}>
      <Icon src={config.icon} alt={config.text} className={`w-3.5 h-3.5 ${config.colorClass}`} />
      {config.text}
    </span>
  );
});
StatusBadge.displayName = 'StatusBadge';

// PERFORMANCE: Memoized Pagination Controls Component
const PaginationControls = memo(({ currentPage, totalPages, pageSize, totalItems, onPageChange, onPageSizeChange, showPageSize = false }) => {
  const pages = useMemo(() => {
    if (totalPages <= 7) return Array.from({ length: totalPages }, (_, i) => i + 1);
    if (currentPage <= 4) return [1, 2, 3, 4, 5, '...', totalPages];
    if (currentPage >= totalPages - 3) return [1, '...', totalPages-4, totalPages-3, totalPages-2, totalPages-1, totalPages];
    return [1, '...', currentPage-1, currentPage, currentPage+1, '...', totalPages];
  }, [currentPage, totalPages]);

  return (
    <div className="flex items-center gap-1.5">
      <button onClick={() => onPageChange(currentPage - 1)} disabled={currentPage === 1}
        className="w-7 h-7 rounded-lg flex items-center justify-center border border-jj-gray-03 bg-white text-jj-gray-06 hover:bg-jj-gray-08 hover:text-white hover:border-jj-gray-08 disabled:opacity-30 disabled:cursor-not-allowed transition-all duration-100">
        <Icon src={chevronLeftIcon} alt="Prev" className="w-3.5 h-3.5" />
      </button>
      {pages.map((p, i) =>
        p === '...'
          ? <span key={`d${i}`} className="w-7 h-7 flex items-center justify-center font-johnson-text text-xs text-jj-gray-04">…</span>
          : <button key={p} onClick={() => onPageChange(p)}
              className={`w-7 h-7 rounded-lg font-johnson-text text-xs font-bold transition-all duration-100
                ${currentPage === p ? 'bg-jj-gray-08 text-white border border-jj-gray-08' : 'bg-white border border-jj-gray-03 text-jj-gray-07 hover:bg-jj-gray-08 hover:text-white hover:border-jj-gray-08'}`}>
              {p}
            </button>
      )}
      <button onClick={() => onPageChange(currentPage + 1)} disabled={currentPage === totalPages}
        className="w-7 h-7 rounded-lg flex items-center justify-center border border-jj-gray-03 bg-white text-jj-gray-06 hover:bg-jj-gray-08 hover:text-white hover:border-jj-gray-08 disabled:opacity-30 disabled:cursor-not-allowed transition-all duration-100">
        <Icon src={chevronDownIcon} alt="Next" className="w-3.5 h-3.5 -rotate-90" />
      </button>
    </div>
  );
});
PaginationControls.displayName = 'PaginationControls';

// PERFORMANCE: Memoized Column-Only Section Component
const ColumnOnlySection = memo(({ title, columns, bgColor, borderColor, textColor, icon: iconSrc }) => {
  if (!columns || columns.length === 0) return null;

  return (
    <div className={`${bgColor} rounded-lg p-3 border-l-4 shadow-md ${borderColor}`}>
      <h4 className={`font-johnson-display text-lg mb-3 flex items-center gap-2 ${textColor}`} style={{ lineHeight: '110%' }}>
        <Icon src={iconSrc} alt={title} className={`w-5 h-5 ${textColor}`} />
        {title} ({columns.length})
      </h4>
      <div className="flex flex-wrap gap-2">
        {columns.map((col, idx) => (
          <span key={idx} className={`px-3 py-1.5 rounded-full text-xs font-johnson-text ${textColor.replace('text', 'bg')} text-white`}>
            {col}
          </span>
        ))}
      </div>
    </div>
  );
});
ColumnOnlySection.displayName = 'ColumnOnlySection';

// PERFORMANCE: Memoized Quality Analysis Card Component
const QualityAnalysisCard = memo(({ title, match, sourceLabel, sourceValue, targetLabel, targetValue }) => (
  <div className={`bg-white rounded-2xl p-6 shadow-md border-l-4 ${match ? 'border-jj-green-03' : 'border-jj-maroon-05'}`}>
    <div className="flex items-center justify-between mb-4">
      <h3 className="font-johnson-display text-lg flex items-center gap-2 text-jj-gray-08" style={{ lineHeight: '110%' }}>
        <Icon src={barChartIcon} alt="Chart" className="w-5 h-5 text-jj-gray-08" />
        {title}
      </h3>
      <StatusBadge status={match ? STATUS.MATCH : STATUS.MISMATCH} />
    </div>
    <div className="font-johnson-text grid grid-cols-1 sm:grid-cols-3 gap-4 text-sm">
      <div>
        <span className="font-semibold block mb-1 text-jj-gray-07">{sourceLabel}:</span>
        <span className="font-johnson-display text-2xl text-jj-gray-08">{sourceValue?.toLocaleString() || 0}</span>
      </div>
      <div>
        <span className="font-semibold block mb-1 text-jj-gray-07">{targetLabel}:</span>
        <span className="font-johnson-display text-2xl text-jj-gray-08">{targetValue?.toLocaleString() || 0}</span>
      </div>
      <div>
        <span className="font-semibold block mb-1 text-jj-gray-07">Match:</span>
        <span className={`font-johnson-display text-2xl flex items-center gap-2 ${match ? 'text-jj-green-03' : 'text-jj-maroon-05'}`}>
          {match ? <><Icon src={checkCircleIcon} alt="Success" className="w-5 h-5 text-jj-green-03" /> Yes</> : <><Icon src={xCircleIcon} alt="Error" className="w-5 h-5 text-jj-maroon-05" /> No</>}
        </span>
      </div>
    </div>
  </div>
));
QualityAnalysisCard.displayName = 'QualityAnalysisCard';

// PERFORMANCE: Memoized Table Row Component
const TableRow = memo(({ table, onSelect, onRefresh, refreshingTable }) => {
  const tableKey = table.table_name;
  const isRefreshing = refreshingTable === tableKey;
  const isNotFound = table.status === 'TABLE_NOT_FOUND';

  const handleClick = useCallback(() => { onSelect(table); }, [table, onSelect]);
  const handleButtonClick = useCallback((e) => { e.stopPropagation(); onSelect(table); }, [table, onSelect]);
  const handleRefreshClick = useCallback((e) => { e.stopPropagation(); onRefresh(table, e); }, [table, onRefresh]);

  const rowMismatch = !table.row_counts?.match && !isNotFound;

  return (
    <tr
      className="group border-t border-jj-gray-02 hover:bg-jj-gray-01 transition-colors duration-100 cursor-pointer"
      onClick={handleClick}
    >
      {/* Source table */}
      <td className="px-5 py-3.5 align-middle">
        <span className="font-johnson-text text-xs font-bold text-jj-gray-08 truncate block max-w-[200px]" title={table.table_name}>
          {table.table_name}
        </span>
      </td>
      {/* L1 table */}
      <td className="px-5 py-3.5 align-middle">
        <span className="font-johnson-text text-xs text-jj-gray-06 truncate block max-w-[200px]" title={table.snowflake_table}>
          {table.snowflake_table}
        </span>
      </td>
      {/* Status */}
      <td className="px-5 py-3.5 align-middle text-center">
        <StatusBadge status={table.status} />
      </td>
      {/* Row counts */}
      <td className="px-5 py-3.5 align-middle text-center">
        {isNotFound ? (
          <span className="font-johnson-text text-xs text-jj-gray-04">—</span>
        ) : (
          <span className={`font-johnson-text text-xs font-bold tabular-nums ${rowMismatch ? 'text-jj-maroon-05' : 'text-jj-gray-07'}`}>
            {table.row_counts?.oracle?.toLocaleString() ?? 0}
          </span>
        )}
      </td>
      <td className="px-5 py-3.5 align-middle text-center">
        {isNotFound ? (
          <span className="font-johnson-text text-xs text-jj-gray-04">—</span>
        ) : (
          <div className="flex items-center justify-center gap-1.5">
            <span className={`font-johnson-text text-xs font-bold tabular-nums ${rowMismatch ? 'text-jj-maroon-05' : 'text-jj-gray-07'}`}>
              {table.row_counts?.snowflake?.toLocaleString() ?? 0}
            </span>
            {rowMismatch && <Icon src={alertTriangleIcon} alt="Mismatch" className="w-3 h-3 text-jj-maroon-05 flex-shrink-0" />}
          </div>
        )}
      </td>
      {/* Last validated */}
      <td className="px-5 py-3.5 align-middle text-center">
        <span className="font-johnson-text text-xs text-jj-gray-05">
          {table.Last_Checked ? formatTimestamp(table.Last_Checked) : '—'}
        </span>
      </td>
      {/* Actions */}
      <td className="px-4 py-3.5 align-middle">
        <div className="flex items-center justify-center gap-2 opacity-60 group-hover:opacity-100 transition-opacity duration-150">
          <button
            onClick={handleRefreshClick}
            disabled={isRefreshing}
            aria-label={`Refresh ${table.table_name}`}
            className="w-8 h-8 rounded-lg flex items-center justify-center bg-jj-gray-01 border border-jj-gray-03 hover:bg-jj-green-03 hover:border-jj-green-03 hover:text-white transition-all duration-150 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <Icon src={isRefreshing ? activityIcon : refreshIcon} alt="Refresh" className={`w-4 h-4 text-jj-gray-06 group-hover:text-jj-gray-08 ${isRefreshing ? 'animate-spin' : ''}`} />
          </button>
          <button
            onClick={handleButtonClick}
            aria-label={`View ${table.table_name}`}
            className="h-8 px-3 rounded-lg text-xs font-johnson-text font-bold bg-jj-gray-08 text-white hover:bg-jj-red transition-all duration-150"
          >
            View
          </button>
        </div>
      </td>
    </tr>
  );
}, (prev, next) =>
  prev.table.table_name === next.table.table_name &&
  prev.table.status === next.table.status &&
  prev.table.row_counts?.match === next.table.row_counts?.match &&
  prev.refreshingTable === next.refreshingTable
);
TableRow.displayName = 'TableRow';

// PERFORMANCE: Lazy loaded Table Detail Modal Component
const TableDetailModal = memo(({ table, onClose }) => {
  const [activeTab, setActiveTab] = useState('columns');
  const [constraintWarningsExpanded, setConstraintWarningsExpanded] = useState(false);

  useEffect(() => {
    const handleKeyPress = (e) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyPress);
    return () => window.removeEventListener('keydown', handleKeyPress);
  }, [onClose]);

  if (!table) return null;
  const safeTableName = table.table_name || 'Unknown Table';

  return (
    <div
      className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4"
      onClick={onClose}
      style={{
        backdropFilter: 'blur(4px)',
        animation: 'fadeIn 0.2s ease-out'
      }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="modal-title"
    >
      <style>
        {`
          @keyframes fadeIn {
            from { opacity: 0; }
            to { opacity: 1; }
          }
          @keyframes slideUp {
            from {
              opacity: 0;
              transform: translateY(20px);
            }
            to {
              opacity: 1;
              transform: translateY(0);
            }
          }
        `}
      </style>
      <div
        className="bg-white rounded-3xl shadow-2xl max-w-7xl w-full flex flex-col"
        onClick={(e) => e.stopPropagation()}
        style={{
          animation: 'slideUp 0.3s ease-out',
          maxHeight: '95vh',
          contain: 'layout style paint'
        }}
      >
        {/* Modal Header */}
        <div className="px-8 py-6 flex items-center justify-between flex-shrink-0 bg-jj-gray-07">
          <div className="flex-1 min-w-0 mr-6">
            <h2 id="modal-title" className="font-johnson-display text-lg mb-3 text-white flex items-center gap-2 overflow-hidden" style={{ lineHeight: '110%' }}>
              <span className="flex items-center gap-2 flex-shrink-0">
                <span className="opacity-90">L0:</span>
                <span className="truncate" title={safeTableName}>{safeTableName}</span>
              </span>
              <span className="flex-shrink-0">→</span>
              <span className="flex items-center gap-2 flex-shrink min-w-0">
                <span className="opacity-90 flex-shrink-0">L1:</span>
                <span className="truncate" title={table.snowflake_table || 'No Snowflake table mapped'}>
                  {table.snowflake_table || 'No Snowflake table mapped'}
                </span>
              </span>
            </h2>
            <div className="flex items-center gap-4 flex-wrap">
              <StatusBadge status={table.status} />
              {table.Last_Checked && (
                <div className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-white bg-opacity-20">
                  <Icon src={clockIcon} alt="Time" className="w-4 h-4 brightness-0 invert" />
                  <span className="font-johnson-text text-sm font-bold text-white">
                    {formatTimestamp(table.Last_Checked)}
                  </span>
                </div>
              )}
            </div>
          </div>
          <button
            onClick={onClose}
            aria-label="Close modal"
            className="font-johnson-text w-10 h-10 flex items-center justify-center rounded-xl bg-white bg-opacity-20 hover:bg-opacity-30 transition-all duration-200 group flex-shrink-0"
          >
            <Icon src={xCircleIcon} alt="Close" className="w-6 h-6 text-white group-hover:rotate-90 transition-transform duration-200" />
          </button>
        </div>



        {/* Tabs */}
        <div className="px-8 flex-shrink-0 bg-jj-gray-01 border-b-2 border-jj-gray-02">
          <div className="flex gap-1 overflow-x-auto" role="tablist">
            {['overview', 'columns', 'quality', 'constraints', 'issues'].map(tab => (
              <button
                key={tab}
                onClick={() => setActiveTab(tab)}
                role="tab"
                aria-selected={activeTab === tab}
                aria-controls={`${tab}-panel`}
                className={`px-6 py-4 font-johnson-text text-sm transition-colors duration-200 relative whitespace-nowrap ${
                  activeTab === tab ? 'text-jj-gray-07' : 'text-jj-gray-06 hover:bg-white hover:bg-opacity-50'
                }`}
              >
                {tab.charAt(0).toUpperCase() + tab.slice(1)}
                {activeTab === tab && (
                  <div className="absolute bottom-0 left-0 right-0 h-1 rounded-t-full bg-jj-gray-07" />
                )}
              </button>
            ))}
          </div>
        </div>

        {/* Modal Content - Scrollable with containment */}
        <div className="flex-1 overflow-y-auto p-8 bg-jj-gray-01" style={{ contain: 'layout style paint' }}>
          {activeTab === 'overview' && (
            <div className="space-y-6" role="tabpanel" id="overview-panel">
              {table.status === 'TABLE_NOT_FOUND' && (
                <div className="bg-jj-gray-02 rounded-2xl p-6 shadow-md border-l-4 border-jj-gray-05 flex items-start gap-4">
                  <Icon src={alertTriangleIcon} alt="Not Found" className="w-8 h-8 text-jj-gray-06 flex-shrink-0 mt-0.5" />
                  <div>
                    <h3 className="font-johnson-display text-lg text-jj-gray-08 mb-1" style={{ lineHeight: '110%' }}>
                      Table Not Found
                    </h3>
                    <p className="font-johnson-text text-sm text-jj-gray-07">
                      {table.error || 'The L1 table could not be located during validation.'}
                    </p>
                  </div>
                </div>
              )}
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
                <div className="bg-white rounded-2xl p-6 shadow-md border-l-4 border-jj-blue-03">
                  <h3 className="font-johnson-display mb-4 text-lg flex items-center gap-2 text-jj-gray-08" style={{ lineHeight: '110%' }}>
                    <Icon src={databaseIcon} alt="Database" className="w-5 h-5 text-jj-blue-03" />
                    Row Counts
                  </h3>
                  <div className="font-johnson-text space-y-3 text-sm">
                    <div className="flex justify-between items-center py-2">
                      <span className="font-semibold text-jj-gray-07">L0:</span>
                      <span className="font-johnson-display text-2xl text-jj-gray-08">
                        {table.row_counts?.oracle?.toLocaleString() || 0}
                      </span>
                    </div>
                    <div className="flex justify-between items-center py-2">
                      <span className="font-semibold text-jj-gray-07">L1:</span>
                      <span className="font-johnson-display text-2xl text-jj-gray-08">
                        {table.row_counts?.snowflake?.toLocaleString() || 0}
                      </span>
                    </div>
                    <div className="flex justify-between items-center pt-3 border-t-2 border-jj-gray-03">
                      <span className="font-semibold text-jj-gray-07">Match:</span>
                      <span className={`font-johnson-text font-bold text-xl flex items-center gap-2 ${table.row_counts?.match ? 'text-jj-green-03' : 'text-jj-maroon-05'}`}>
                        {table.row_counts?.match ? <Icon src={checkCircleIcon} alt="Success" className="w-5 h-5 text-jj-green-03" /> : <Icon src={xCircleIcon} alt="Error" className="w-5 h-5 text-jj-maroon-05" />}
                        {table.row_counts?.match ? 'Yes' : 'No'}
                      </span>
                    </div>
                  </div>
                </div>

                <div className="bg-white rounded-2xl p-6 shadow-md border-l-4 border-jj-green-03">
                  <h3 className="font-johnson-display mb-4 text-lg flex items-center gap-2 text-jj-gray-08" style={{ lineHeight: '110%' }}>
                    <Icon src={barChartIcon} alt="Chart" className="w-5 h-5 text-jj-green-03" />
                    Data Quality
                  </h3>
                  <div className="font-johnson-text space-y-3 text-sm">
                    <div className="flex justify-between items-center py-2">
                      <span className="font-semibold text-jj-gray-07">L0 Nulls:</span>
                      <span className="font-johnson-display text-2xl text-jj-gray-08">
                        {table.data_quality?.oracle_nulls?.toLocaleString() || 0}
                      </span>
                    </div>
                    <div className="flex justify-between items-center py-2">
                      <span className="font-semibold text-jj-gray-07">L1 Nulls:</span>
                      <span className="font-johnson-display text-2xl text-jj-gray-08">
                        {table.data_quality?.snowflake_nulls?.toLocaleString() || 0}
                      </span>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}

          {activeTab === 'columns' && (() => {
            const typeMismatches = (table.column_statistics || []).filter(col =>
              col.oracle_type && col.snowflake_type && col.oracle_type !== col.snowflake_type
            );
            return (
            <div className="space-y-6" role="tabpanel" id="columns-panel">
              <div className="bg-white rounded-2xl p-6 shadow-md">
                <h3 className="font-johnson-display mb-4 text-lg text-jj-gray-08" style={{ lineHeight: '110%' }}>Column Analysis</h3>
                <div className="font-johnson-text grid grid-cols-2 sm:grid-cols-4 gap-6 text-sm">
                  {[
                    { value: table.column_analysis?.oracle_columns || 0, label: 'L0 Columns', color: 'text-jj-blue-03' },
                    { value: table.column_analysis?.snowflake_columns || 0, label: 'L1 Columns', color: 'text-jj-blue-03' },
                    { value: table.column_analysis?.common_columns || 0, label: 'Common Columns', color: 'text-jj-green-03' },
                    { value: typeMismatches.length, label: 'Type Mismatches', color: typeMismatches.length > 0 ? 'text-jj-orange-03' : 'text-jj-green-03' },
                  ].map((item, idx) => (
                    <div key={idx} className="text-center">
                      <div className={`text-4xl font-bold mb-2 ${item.color}`}>{item.value}</div>
                      <div className="font-semibold text-jj-gray-07">{item.label}</div>
                    </div>
                  ))}
                </div>
              </div>

              {typeMismatches.length > 0 && (
                <div className="bg-orange-50 rounded-2xl shadow-md overflow-hidden border-l-4 border-jj-orange-03">
                  <div className="px-6 py-4 flex items-center gap-3 border-b border-orange-200">
                    <Icon src={alertTriangleIcon} alt="Warning" className="w-5 h-5 text-jj-orange-03 flex-shrink-0" />
                    <h3 className="font-johnson-display text-lg text-jj-orange-03" style={{ lineHeight: '110%' }}>
                      Type Mismatches ({typeMismatches.length} {typeMismatches.length === 1 ? 'column' : 'columns'})
                    </h3>
                  </div>
                  <div className="overflow-x-auto">
                    <table className="font-johnson-text w-full text-sm">
                      <thead>
                        <tr className="bg-orange-100">
                          <th className="px-5 py-3 text-left text-xs font-bold text-jj-orange-03">Column</th>
                          <th className="px-5 py-3 text-left text-xs font-bold text-jj-orange-03">L0 Type</th>
                          <th className="px-5 py-3 text-left text-xs font-bold text-jj-orange-03">L1 Type</th>
                        </tr>
                      </thead>
                      <tbody>
                        {typeMismatches.map((col, idx) => (
                          <tr key={idx} className="border-t border-orange-200">
                            <td className="px-5 py-3 font-bold text-jj-gray-08">{col.column_name}</td>
                            <td className="px-5 py-3">
                              <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-orange-100 text-jj-orange-03 font-bold text-xs font-johnson-text">
                                {col.oracle_type}
                              </span>
                            </td>
                            <td className="px-5 py-3">
                              <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-orange-100 text-jj-orange-03 font-bold text-xs font-johnson-text">
                                {col.snowflake_type}
                              </span>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {table.column_statistics && table.column_statistics.length > 0 && (
                <div className="bg-white rounded-2xl shadow-md overflow-hidden">
                  <div className="overflow-hidden">
                    <table className="font-johnson-text w-full text-sm table-fixed">
                      <thead className="bg-jj-gray-01">
                        <tr>
                          <th className="font-johnson-text px-4 py-4 text-left font-bold text-jj-gray-08 w-[40%]">Column Name</th>
                          <th className="font-johnson-text px-3 py-4 text-left font-bold text-jj-gray-08 w-[30%]">L0 Type</th>
                          <th className="font-johnson-text px-3 py-4 text-left font-bold text-jj-gray-08 w-[30%]">L1 Type</th>
                        </tr>
                      </thead>
                      <tbody>
                        {table.column_statistics.map((col, idx) => {
                          const typeMatch = !col.oracle_type || !col.snowflake_type || col.oracle_type === col.snowflake_type;
                          return (
                            <tr
                              key={idx}
                              className={`border-t transition-colors border-jj-gray-03 ${!typeMatch ? 'bg-orange-50 hover:bg-orange-100' : 'hover:bg-gray-50'}`}
                            >
                              <td className="font-johnson-text px-4 py-4 font-bold text-jj-gray-08" title={col.column_name}>
                                <div className="truncate">{col.column_name}</div>
                              </td>
                              <td className={`font-johnson-text px-3 py-4 ${!typeMatch ? 'bg-orange-100' : ''}`} title={col.oracle_type || 'N/A'}>
                                <div className={`truncate text-xs font-bold ${!typeMatch ? 'text-jj-orange-03' : 'text-jj-gray-07'}`}>
                                  {col.oracle_type || 'N/A'}
                                </div>
                              </td>
                              <td className={`font-johnson-text px-3 py-4 ${!typeMatch ? 'bg-orange-100' : ''}`} title={col.snowflake_type || 'N/A'}>
                                <div className={`truncate text-xs font-bold ${!typeMatch ? 'text-jj-orange-03' : 'text-jj-gray-07'}`}>
                                  {!typeMatch && <Icon src={alertTriangleIcon} alt="Mismatch" className="w-3 h-3 text-jj-orange-03 inline-block mr-1 flex-shrink-0" />}
                                  {col.snowflake_type || 'N/A'}
                                </div>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              <ColumnOnlySection
                title="L0-Only Columns"
                columns={table.column_analysis?.oracle_only_columns}
                bgColor="bg-jj-gray-01"
                borderColor="border-jj-gray-05"
                textColor="text-jj-gray-07"
                icon={infoIcon}
              />

              <ColumnOnlySection
                title="L1-Only Columns"
                columns={table.column_analysis?.snowflake_only_columns}
                bgColor="bg-blue-50"
                borderColor="border-jj-blue-03"
                textColor="text-jj-blue-03"
                icon={infoIcon}
              />
            </div>
            );
          })()}

          {activeTab === 'quality' && (
            <div className="space-y-6" role="tabpanel" id="quality-panel">
              {table.data_quality ? (
                <div className="space-y-4">
                  <QualityAnalysisCard
                    title="Null Count Analysis"
                    match={table.data_quality.null_match}
                    sourceLabel="L0 Nulls"
                    sourceValue={table.data_quality.oracle_nulls}
                    targetLabel="L1 Nulls"
                    targetValue={table.data_quality.snowflake_nulls}
                  />
                  <QualityAnalysisCard
                    title="Duplicate Count Analysis"
                    match={table.data_quality.duplicate_match}
                    sourceLabel="L0 Duplicates"
                    sourceValue={table.data_quality.oracle_duplicates}
                    targetLabel="L1 Duplicates"
                    targetValue={table.data_quality.snowflake_duplicates}
                  />
                </div>
              ) : (
                <div className="text-center py-20 bg-white rounded-2xl shadow-md">
                  <Icon src={barChartIcon} alt="Chart" className="w-20 h-20 mx-auto mb-4 opacity-30 text-jj-gray-05" />
                  <p className="font-johnson-text text-lg font-bold text-jj-gray-07">
                    No data quality information available
                  </p>
                </div>
              )}
            </div>
          )}

          {activeTab === 'constraints' && (
            <div className="space-y-6" role="tabpanel" id="constraints-panel">
              {table.constraint_analysis ? (
                <div className="space-y-4">
                  {table.constraint_analysis.summary && (
                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">
                      {Object.entries(table.constraint_analysis.summary).map(([type, status]) => {
                        const getBorderColor = (status) => {
                          if (status === STATUS.MATCH) return 'border-jj-green-03';
                          if (status === STATUS.MISMATCH) return 'border-jj-maroon-05';
                          if (status === STATUS.DEFINITION_MISMATCH) return 'border-jj-orange-03';
                          return 'border-jj-gray-05';
                        };

                        return (
                          <div
                            key={type}
                            className={`bg-white rounded-xl p-4 shadow-md border-l-4 ${getBorderColor(status)}`}
                          >
                            <div className="font-johnson-text text-xs font-bold mb-2 text-jj-gray-07">
                              {type.replace(/_/g, ' ')}
                            </div>
                            <StatusBadge status={status} />
                          </div>
                        );
                      })}
                    </div>
                  )}

                  {table.constraint_analysis.validation_results?.not_null_constraints?.details && (
                    <div className="bg-white rounded-xl shadow-md overflow-hidden border-l-4 border-jj-green-03">
                      <div className="flex items-center justify-between p-5 pb-3">
                        <h3 className="font-johnson-display text-lg flex items-center gap-2 text-jj-gray-08" style={{ lineHeight: '110%' }}>
                          <Icon src={shieldCheckIcon} alt="Shield" className="w-6 h-6 text-jj-red" />
                          NOT NULL Constraint Validation
                        </h3>
                        <StatusBadge status={table.constraint_analysis.validation_results.not_null_constraints.status} />
                      </div>
                      <div className="overflow-x-auto">
                        <table className="w-full font-johnson-text text-sm">
                          <thead className="bg-jj-gray-01">
                            <tr>
                              <th className="font-johnson-text px-5 py-3 text-left text-xs font-bold text-jj-gray-08">
                                Column Name
                              </th>
                              <th className="font-johnson-text px-5 py-3 text-center text-xs font-bold text-jj-gray-08">
                                L1 Null Count
                              </th>
                              <th className="font-johnson-text px-5 py-3 text-center text-xs font-bold text-jj-gray-08">
                                Status
                              </th>
                            </tr>
                          </thead>
                          <tbody>
                            {table.constraint_analysis.validation_results.not_null_constraints.details.map((detail, idx) => (
                              <tr
                                key={idx}
                                className="border-t hover:bg-gray-50 transition-colors border-jj-gray-03"
                              >
                                <td className="font-johnson-text px-5 py-4">
                                  <span className="font-bold text-jj-gray-08">
                                    {detail.column}
                                  </span>
                                </td>
                                <td className="font-johnson-text px-5 py-4 text-center">
                                  <span
                                    className={`px-4 py-2 rounded-full text-sm font-bold ${
                                      detail.snowflake_null_count > 0
                                        ? 'bg-jj-maroon-05 bg-opacity-20 text-jj-maroon-05'
                                        : 'bg-jj-green-03 bg-opacity-20 text-jj-green-03'
                                    }`}
                                  >
                                    {detail.snowflake_null_count?.toLocaleString() || 0}
                                  </span>
                                </td>
                                <td className="font-johnson-text px-5 py-4 text-center">
                                  {detail.validation_status && (
                                    <StatusBadge status={detail.validation_status} />
                                  )}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  )}

                  {table.constraint_analysis.constraint_warnings && table.constraint_analysis.constraint_warnings.length > 0 && (
                    <div className="bg-orange-50 rounded-xl overflow-hidden border-2 shadow-md border-jj-orange-03 border-opacity-25">
                      <button
                        onClick={() => setConstraintWarningsExpanded(!constraintWarningsExpanded)}
                        aria-expanded={constraintWarningsExpanded}
                        className="w-full p-5 flex items-center justify-between transition-all duration-200 hover:bg-orange-100"
                      >
                        <div className="flex items-center gap-3">
                          <Icon src={alertTriangleIcon} alt="Warning" className="w-6 h-6 text-jj-orange-03" />
                          <span className="font-johnson-text font-bold text-lg text-jj-orange-03">
                            Constraint Warnings ({table.constraint_analysis.constraint_warnings.length})
                          </span>
                        </div>
                        {constraintWarningsExpanded ? (
                          <Icon src={chevronDownIcon} alt="Expand" className="w-5 h-5 text-jj-orange-03" />
                        ) : (
                          <Icon src={chevronRightIcon} alt="Collapse" className="w-5 h-5 text-jj-orange-03" />
                        )}
                      </button>
                      {constraintWarningsExpanded && (
                        <div className="px-5 pb-5 space-y-2">
                          {table.constraint_analysis.constraint_warnings.map((warning, i) => (
                            <div
                              key={i}
                              className="bg-white p-3 rounded-lg shadow-md flex items-start gap-2"
                            >
                              <Icon src={alertTriangleIcon} alt="Warning" className="w-4 h-4 mt-0.5 flex-shrink-0 text-jj-orange-03" />
                              <p className="font-johnson-text text-sm font-medium text-jj-gray-08">
                                {warning}
                              </p>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              ) : (
                <div className="text-center py-20 bg-white rounded-2xl shadow-md">
                  <Icon src={shieldCheckIcon} alt="Shield" className="w-20 h-20 mx-auto mb-4 opacity-30 text-jj-gray-05" />
                  <p className="font-johnson-text text-lg font-bold text-jj-gray-07">
                    No constraint analysis available
                  </p>
                </div>
              )}
            </div>
          )}

          {activeTab === 'issues' && (() => {
            const typeIssues = (table.column_statistics || [])
              .filter(col => col.oracle_type && col.snowflake_type && col.oracle_type !== col.snowflake_type)
              .map(col => `Type mismatch on column ${col.column_name}: L0=${col.oracle_type}, L1=${col.snowflake_type}`);
            const allIssues = [...(table.validation_issues || []), ...typeIssues];
            return (
            <div className="space-y-2" role="tabpanel" id="issues-panel">
              {allIssues.length > 0 ? (
                allIssues.map((issue, idx) => {
                  const isTypeMismatch = issue.startsWith('Type mismatch');
                  return (
                    <div
                      key={idx}
                      className={`rounded-xl p-4 flex items-start gap-3 shadow-md border-l-4 ${isTypeMismatch ? 'bg-orange-50 border-jj-orange-03' : 'bg-red-50 border-jj-maroon-05'}`}
                    >
                      <Icon
                        src={isTypeMismatch ? alertTriangleIcon : xCircleIcon}
                        alt={isTypeMismatch ? 'Warning' : 'Error'}
                        className={`w-5 h-5 mt-0.5 flex-shrink-0 ${isTypeMismatch ? 'text-jj-orange-03' : 'text-jj-maroon-05'}`}
                      />
                      <div className="flex-1">
                        <p className="font-johnson-text text-sm font-medium text-jj-gray-08">
                          {issue}
                        </p>
                      </div>
                      {isTypeMismatch && (
                        <span className="font-johnson-text text-xs font-bold px-2 py-1 rounded-full bg-orange-100 text-jj-orange-03 flex-shrink-0">
                          Type
                        </span>
                      )}
                    </div>
                  );
                })
              ) : (
                <div className="text-center py-20 bg-white rounded-2xl shadow-md">
                  <Icon src={checkCircleIcon} alt="Success" className="w-24 h-24 mx-auto mb-4 text-jj-green-03" />
                  <p className="font-johnson-text text-2xl font-bold mb-2 text-jj-green-03">
                    No Issues Found
                  </p>
                  <p className="font-johnson-text text-sm font-medium text-jj-gray-07">
                    This table validation completed successfully
                  </p>
                </div>
              )}
            </div>
            );
          })()}
        </div>
      </div>
    </div>
  );
});
TableDetailModal.displayName = 'TableDetailModal';

// Main Dashboard Component
function DataTypeValidation() {
  const { hasPermission } = useRBAC();
  const [reportData, setReportData] = useState(null);
  const [selectedTable, setSelectedTable] = useState(null);
  const [refreshingTable, setRefreshingTable] = useState(null);
  const [toast, setToast] = useState(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [debouncedSearchTerm, setDebouncedSearchTerm] = useState('');
  const [isSearching, setIsSearching] = useState(false);
  const [statusFilter, setStatusFilter] = useState(STATUS.ALL);
  const [selectedL0Schema, setSelectedL0Schema] = useState('');
  const [selectedL1Schema, setSelectedL1Schema] = useState('');

  // Pagination state
  const [currentPage, setCurrentPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);

  // UI state
  const [showWelcome, setShowWelcome] = useState(true);
  const [selectedEnvironment, setSelectedEnvironment] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [loadError, setLoadError] = useState('');

  // Refs for keyboard navigation
  const searchInputRef = useRef(null);

  // Improved search debounce with indicator
  useEffect(() => {
    setIsSearching(true);
    const timer = setTimeout(() => {
      setDebouncedSearchTerm(searchTerm);
      setCurrentPage(1);
      setIsSearching(false);
    }, 500);

    return () => {
      clearTimeout(timer);
      setIsSearching(false);
    };
  }, [searchTerm]);

  // Keyboard navigation
  useEffect(() => {
    const handleKeyPress = (e) => {
      if (e.key === 'Escape' && selectedTable) {
        setSelectedTable(null);
      }

      if ((e.metaKey || e.ctrlKey) && e.key === 'f') {
        e.preventDefault();
        searchInputRef.current?.focus();
      }

      if (document.activeElement?.tagName !== 'INPUT' && !selectedTable) {
        if (e.key === 'ArrowLeft' && currentPage > 1) {
          handlePageChange(currentPage - 1);
        } else if (e.key === 'ArrowRight' && currentPage < totalPages) {
          handlePageChange(currentPage + 1);
        }
      }
    };

    window.addEventListener('keydown', handleKeyPress);
    return () => window.removeEventListener('keydown', handleKeyPress);
  }, [selectedTable, currentPage]);

  // PERFORMANCE OPTIMIZATION: Split filtering into smaller memos
  const allTables = useMemo(() => {
    try {
      if (!reportData?.schema_results) return [];
      const meta = reportData.report_metadata || {};
      return reportData.schema_results.flatMap(schema =>
        (schema.table_validations || []).map(table => ({
          ...normalizeTable(table),
          source_schema: schema.l0_schema || 'Unknown',
          target_database: meta.l1_database || 'Unknown',
          target_schema: schema.l1_schema || 'Unknown',
        }))
      );
    } catch (error) {
      console.error('Error extracting tables:', error);
      return [];
    }
  }, [reportData]);

  const availableL0Schemas = useMemo(() => {
    if (!reportData?.schema_results) return [];
    return [...new Set(reportData.schema_results.map(s => s.l0_schema).filter(Boolean))].sort();
  }, [reportData]);

  const availableL1Schemas = useMemo(() => {
    if (!reportData?.schema_results) return [];
    return [...new Set(reportData.schema_results.map(s => s.l1_schema).filter(Boolean))].sort();
  }, [reportData]);

  const filteredTables = useMemo(() => {
    let tables = allTables;

    if (debouncedSearchTerm) {
      const search = debouncedSearchTerm.toLowerCase();
      tables = tables.filter(table => {
        const tName = (table.table_name || '').toLowerCase();
        const sName = (table.snowflake_table || '').toLowerCase();
        return tName.includes(search) || sName.includes(search);
      });
    }

    if (statusFilter !== STATUS.ALL) {
      tables = tables.filter(table => table.status === statusFilter);
    }
    if (selectedL0Schema) {
      tables = tables.filter(table => table.source_schema === selectedL0Schema);
    }
    if (selectedL1Schema) {
      tables = tables.filter(table => table.target_schema === selectedL1Schema);
    }

    // Sort: FAULTY first, TABLE_NOT_FOUND last, everything else in between
    const statusOrder = {
      [STATUS.FAULTY]: 0,
      [STATUS.CRITICAL]: 1,
      [STATUS.ERROR]: 2,
      [STATUS.TIMEOUT]: 3,
      [STATUS.PASSED]: 4,
      [STATUS.TABLE_NOT_FOUND]: 5,
    };
    tables.sort((a, b) => {
      const aOrder = statusOrder[a.status] ?? 3;
      const bOrder = statusOrder[b.status] ?? 3;
      if (aOrder !== bOrder) return aOrder - bOrder;
      return (a.table_name || '').localeCompare(b.table_name || '');
    });

    return tables;
  }, [allTables, debouncedSearchTerm, statusFilter, selectedL0Schema, selectedL1Schema]);


  const handleEnvironmentChange = useCallback((env) => {
    setSelectedEnvironment(env);
    setLoadError('');
  }, []);

  const handleLoadData = useCallback(async () => {
    if (!selectedEnvironment) {
      setLoadError('Please select an environment');
      return;
    }

    setIsLoading(true);
    setLoadError('');

    try {
      const response = await apiFetch(`/dq/validation_report?environment=${selectedEnvironment}`);

      if (!response.ok) {
        throw new Error(`Failed to load validation report: ${response.statusText}`);
      }

      const data = await response.json();

      if (!data.report_data?.schema_results) {
        throw new Error('Invalid data format received from server');
      }

      setReportData(data.report_data);
      setSearchTerm('');
      setStatusFilter(STATUS.ALL);
      setSelectedL0Schema('');
      setSelectedL1Schema('');
      setCurrentPage(1);
      setShowWelcome(false);
      setIsLoading(false);
    } catch (error) {
      console.error('Error loading validation report:', error);
      setLoadError(`Failed to load data for ${selectedEnvironment} environment: ${error.message}`);
      setIsLoading(false);
    }
  }, [selectedEnvironment]);

  // Paginated tables
  const paginatedTables = useMemo(() => {
    const startIndex = (currentPage - 1) * pageSize;
    const endIndex = startIndex + pageSize;
    return filteredTables.slice(startIndex, endIndex);
  }, [filteredTables, currentPage, pageSize]);

  const totalPages = Math.max(1, Math.ceil(filteredTables.length / Math.max(1, pageSize)));

  const filteredSummary = useMemo(() => {
    return {
      total_tables_validated: filteredTables.length,
      total_passed: filteredTables.filter(t => t.status === STATUS.PASSED).length,
      total_critical: filteredTables.filter(t => t.status === STATUS.CRITICAL).length,
      total_faulty: filteredTables.filter(t => t.status === STATUS.FAULTY).length,
      total_errors: filteredTables.filter(t => t.status === STATUS.ERROR).length,
      total_not_found: filteredTables.filter(t => t.status === STATUS.TIMEOUT || t.status === STATUS.TABLE_NOT_FOUND).length
    };
  }, [filteredTables]);

  const handlePageChange = useCallback((page) => {
    setCurrentPage(Math.max(1, Math.min(page, totalPages)));
  }, [totalPages]);

  const handlePageSizeChange = useCallback((e) => {
    setPageSize(Number(e.target.value));
    setCurrentPage(1);
  }, []);

  const handleTableSelect = useCallback((table) => {
    setSelectedTable(table);
  }, []);

  const showToast = useCallback((message, type = 'success') => {
    setToast({ message, type });
  }, []);

  const handleRefreshTable = useCallback(async (table, e) => {
    e?.stopPropagation();

    const tableKey = table.table_name;
    setRefreshingTable(tableKey);

    try {
      const response = await apiFetch(`/dq/validate_single_table`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          environment: selectedEnvironment,
          l0_table: table.table_name,
          l1_table: table.snowflake_table,
          l0_schema: table.source_schema,
          l1_database: table.target_database,
          l1_schema: table.target_schema,
        })
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.detail || 'Validation failed');
      }

      const data = await response.json();

      if (data.success && data.validation_result) {
        setReportData(prevReport => {
          if (!prevReport?.schema_results) return prevReport;
          return {
            ...prevReport,
            schema_results: prevReport.schema_results.map(schema => ({
              ...schema,
              table_validations: (schema.table_validations || []).map(t =>
                t.l0_table === table.table_name ? { ...t, ...data.validation_result } : t
              ),
            })),
          };
        });
        showToast(`✓ ${table.table_name} validated successfully`, 'success');
      }
    } catch (error) {
      console.error('Error refreshing table validation:', error);
      showToast(`Failed to validate ${table.table_name}: ${error.message}`, 'error');
    } finally {
      setRefreshingTable(null);
    }
  }, [selectedEnvironment, showToast]);

  const getEmptyStateMessage = () => {
    if (searchTerm) {
      return {
        title: 'No tables match your search',
        message: `No results found for "${searchTerm}"`,
        action: 'Try a different search term or clear the search'
      };
    }

    if (statusFilter !== STATUS.ALL) {
      return {
        title: `No tables with status: ${statusFilter}`,
        message: 'No tables match the selected status filter',
        action: 'Try selecting a different status or remove the filter'
      };
    }

    return {
      title: 'No tables available',
      message: 'No validation data is currently available',
      action: 'Please check back later or contact support'
    };
  };

  // Welcome Screen
  if (showWelcome) {
    return (
      <div className="min-h-screen flex bg-jj-gray-01">
        {/* Left panel — brand hero */}
        <div className="hidden lg:flex lg:w-1/2 relative flex-col justify-between p-12 bg-white border-r border-jj-gray-02 overflow-hidden">
          {/* Background geometric accent */}
          <div className="absolute inset-0 pointer-events-none">
            <div className="absolute -top-32 -right-32 w-96 h-96 rounded-full bg-jj-red opacity-5" />
            <div className="absolute bottom-0 -left-24 w-80 h-80 rounded-full bg-jj-gray-01 opacity-80" />
            <div className="absolute top-1/2 right-0 w-1 h-48 bg-jj-gray-03 opacity-40 transform -translate-y-1/2" />
          </div>

          {/* Top logo area */}
          <div className="relative">
            <div className="flex items-center gap-3 mb-2">
              <div className="w-10 h-10 bg-jj-red rounded-xl flex items-center justify-center">
                <Icon src={shieldCheckIcon} alt="Shield" className="w-6 h-6 brightness-0 invert" />
              </div>
              <span className="font-johnson-text text-jj-gray-06 text-sm font-bold tracking-widest uppercase">
                Johnson &amp; Johnson
              </span>
            </div>
          </div>

          {/* Centre content */}
          <div className="relative">
            <p className="font-johnson-text text-jj-gray-05 text-sm font-bold tracking-widest uppercase mb-4">
              Snowflake
            </p>
            <h1 className="font-johnson-display text-jj-gray-08 mb-6" style={{ fontSize: '3.25rem', lineHeight: '108%' }}>
              L0 → L1<br />Data Type Validation
            </h1>
            <p className="font-johnson-text text-jj-gray-06 text-base leading-relaxed max-w-xs">
              End-to-end row count, column type, and constraint validation from Snowflake L0 to Snowflake L1 — surfacing data issues before they reach production.
            </p>

            {/* Divider */}
            <div className="mt-10 pt-10 border-t border-white border-opacity-20">
              <div className="grid grid-cols-3 gap-6">
                {[
                  { icon: databaseIcon, label: 'Row Counts', sub: 'L0 vs L1' },
                  { icon: barChartIcon, label: 'Column Types', sub: 'Mismatch Detection' },
                  { icon: shieldCheckIcon, label: 'Constraints', sub: 'NOT NULL · PK' },
                ].map((item, i) => (
                  <div key={i} className="flex flex-col items-center text-center gap-2">
                    <div className="w-10 h-10 rounded-xl bg-jj-gray-01 border border-jj-gray-02 flex items-center justify-center">
                      <Icon src={item.icon} alt={item.label} className="w-5 h-5 text-jj-gray-06" />
                    </div>
                    <div>
                      <p className="font-johnson-text text-jj-gray-08 text-xs font-bold">{item.label}</p>
                      <p className="font-johnson-text text-jj-gray-05 text-xs">{item.sub}</p>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* Footer */}
          <div className="relative">
            <p className="font-johnson-text text-jj-gray-04 text-xs">
              Confidential · For Internal Use Only
            </p>
          </div>
        </div>

        {/* Right panel — selection form */}
        <div className="flex-1 flex flex-col justify-center px-8 py-12 lg:px-16 xl:px-24" style={{ backgroundImage: 'radial-gradient(circle, #c8c8cc 1px, transparent 1px)', backgroundSize: '20px 20px' }}>

          {/* Mobile header */}
          <div className="lg:hidden mb-10 text-center">
            <div className="w-14 h-14 bg-jj-red rounded-2xl flex items-center justify-center mx-auto mb-4 shadow-lg">
              <Icon src={shieldCheckIcon} alt="DQE" className="w-8 h-8 brightness-0 invert" />
            </div>
            <h1 className="font-johnson-display text-3xl text-jj-gray-08 mb-1" style={{ lineHeight: '110%' }}>
              L0 → L1 Data Type Validation
            </h1>
            <p className="font-johnson-text text-sm text-jj-gray-05 font-medium">
              Snowflake L0 → L1 · Data Type Validation
            </p>
          </div>

          <div className="max-w-md w-full mx-auto">
            <div className="mb-10">
              <h2 className="font-johnson-display text-2xl text-jj-gray-08 mb-2" style={{ lineHeight: '110%' }}>
                Select Environment
              </h2>
              <p className="font-johnson-text text-sm text-jj-gray-06">
                Choose the environment to load the latest L0 → L1 validation report.
              </p>
            </div>

            {/* Environment cards */}
            <div className="space-y-3 mb-8">
              {[
                // { env: 'DEV', label: 'Development', desc: 'Active development & feature branches' },
                { env: 'QA',  label: 'Quality Assurance', desc: 'Staged release testing environment' },
                { env: 'PROD', label: 'Production', desc: 'Live data — handle with care' },
              ].map(({ env, label, desc }) => {
                const isSelected = selectedEnvironment === env;
                const isProd = env === 'PROD';
                return (
                  <button
                    key={env}
                    onClick={() => handleEnvironmentChange(env)}
                    className={`w-full flex items-center gap-4 px-5 py-4 rounded-xl border-2 text-left transition-all duration-200 group
                      ${isSelected
                        ? isProd
                          ? 'border-jj-maroon-05 bg-red-50 shadow-md'
                          : 'border-jj-red bg-red-50 shadow-md'
                        : 'border-jj-gray-03 bg-white hover:border-jj-gray-05 hover:shadow-sm'
                      }`}
                  >
                    <div className={`w-10 h-10 rounded-lg flex items-center justify-center flex-shrink-0 transition-colors duration-200
                      ${isSelected
                        ? isProd ? 'bg-jj-maroon-05' : 'bg-jj-red'
                        : 'bg-jj-gray-01 group-hover:bg-jj-gray-02'
                      }`}>
                      <Icon
                        src={databaseIcon}
                        alt={env}
                        className={`w-5 h-5 ${isSelected ? 'brightness-0 invert' : 'text-jj-gray-06'}`}
                      />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className={`font-johnson-display text-base ${isSelected ? isProd ? 'text-jj-maroon-05' : 'text-jj-red' : 'text-jj-gray-08'}`}
                          style={{ lineHeight: '130%' }}>
                          {label}
                        </span>
                        <span className={`font-johnson-text text-xs font-bold px-2 py-0.5 rounded-full
                          ${isProd
                            ? isSelected ? 'bg-jj-maroon-05 text-white' : 'bg-red-50 text-jj-maroon-05'
                            : isSelected ? 'bg-jj-red text-white' : 'bg-jj-gray-01 text-jj-gray-06'
                          }`}>
                          {env}
                        </span>
                      </div>
                      <p className="font-johnson-text text-xs text-jj-gray-06 mt-0.5">{desc}</p>
                    </div>
                    <div className={`w-5 h-5 rounded-full border-2 flex items-center justify-center flex-shrink-0 transition-colors duration-200
                      ${isSelected
                        ? isProd ? 'border-jj-maroon-05 bg-jj-maroon-05' : 'border-jj-red bg-jj-red'
                        : 'border-jj-gray-04'
                      }`}>
                      {isSelected && (
                        <div className="w-2 h-2 rounded-full bg-white" />
                      )}
                    </div>
                  </button>
                );
              })}
            </div>

            {/* Error */}
            {loadError && (
              <div className="flex items-start gap-3 px-4 py-3 rounded-xl bg-red-50 border border-jj-maroon-05 border-opacity-30 mb-6">
                <Icon src={alertTriangleIcon} alt="Error" className="w-4 h-4 mt-0.5 flex-shrink-0 text-jj-maroon-05" />
                <p className="font-johnson-text text-sm text-jj-maroon-05 font-medium">{loadError}</p>
              </div>
            )}

            {/* CTA */}
            <button
              onClick={handleLoadData}
              disabled={isLoading || !selectedEnvironment}
              aria-label="Load validation report"
              className={`w-full py-4 px-6 rounded-xl font-johnson-text font-bold text-base flex items-center justify-center gap-3 transition-all duration-200 shadow-lg text-white
                ${!selectedEnvironment || isLoading
                  ? 'bg-jj-red opacity-50 cursor-not-allowed'
                  : 'bg-jj-red hover:bg-jj-maroon-05 active:scale-[0.98]'
                }`}
            >
              {isLoading ? (
                <>
                  <Icon src={activityIcon} alt="Loading" className="w-5 h-5 animate-spin brightness-0 invert" />
                  Loading Report...
                </>
              ) : (
                <>
                  <Icon src={shieldCheckIcon} alt="Run" className="w-5 h-5 brightness-0 invert" />
                  Run Validation
                </>
              )}
            </button>

            <p className="font-johnson-text text-xs text-jj-gray-05 text-center mt-6">
              © {new Date().getFullYear()} Johnson &amp; Johnson · Confidential
            </p>
          </div>
        </div>
      </div>
    );
  }
  if (isLoading) {
    return (
      <div className="h-screen flex" style={{ background: '#f0f0f2', backgroundImage: 'radial-gradient(circle, #c4c4c8 1px, transparent 1px)', backgroundSize: '20px 20px' }}>
        <div className="w-56 bg-white border-r border-jj-gray-02 flex flex-col items-center justify-center gap-3 flex-shrink-0">
          <div className="w-10 h-10 rounded-xl bg-jj-red flex items-center justify-center">
            <Icon src={shieldCheckIcon} alt="DQE" className="w-5 h-5 brightness-0 invert" />
          </div>
          <p className="font-johnson-display text-jj-gray-08 text-sm text-center px-4" style={{ lineHeight: '130%' }}>L0 → L1 Data Type Validation</p>
          <span className="font-johnson-text text-xs font-bold px-2.5 py-1 rounded-full bg-jj-red text-white">{selectedEnvironment}</span>
        </div>
        <div className="flex-1 flex flex-col items-center justify-center gap-4">
          <LoadingSpinner />
          <p className="font-johnson-display text-lg text-jj-gray-07">Loading validation data…</p>
        </div>
      </div>
    );
  }

  if (!reportData) {
    return null;
  }

  const emptyState = getEmptyStateMessage();

  const passRate = filteredSummary.total_tables_validated > 0
    ? Math.round((filteredSummary.total_passed / filteredSummary.total_tables_validated) * 100)
    : 0;

  const activeFilters = [selectedL0Schema, selectedL1Schema, statusFilter !== STATUS.ALL ? statusFilter : ''].filter(Boolean).length;
  const clearAll = () => { setSelectedL0Schema(''); setSelectedL1Schema(''); setStatusFilter(STATUS.ALL); setSearchTerm(''); setCurrentPage(1); };

  return (
    <ErrorBoundary>
      <div className="min-h-screen flex flex-col" style={{ background: '#f4f4f6', backgroundImage: 'radial-gradient(circle, #c8c8cc 1px, transparent 1px)', backgroundSize: '20px 20px' }}>

        {/* ── TOP NAV ─────────────────────────────────────────────────── */}
        <header className="flex-shrink-0 bg-white border-b border-jj-gray-02">
          <div className="h-0.5 bg-jj-red w-full" />
          <div className="px-6 py-3 flex items-center justify-between gap-6">
            {/* Left: Brand + title */}
            <div className="flex items-center gap-4 min-w-0">
              <div className="w-9 h-9 rounded-lg bg-jj-red flex items-center justify-center flex-shrink-0">
                <Icon src={shieldCheckIcon} alt="DQE" className="w-5 h-5 brightness-0 invert" />
              </div>
              <div className="min-w-0">
                <h1 className="font-johnson-display text-jj-gray-08 text-base leading-tight">
                  L0 → L1 Data Type Validation
                </h1>
                <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                  <span className="font-johnson-text text-xs font-bold px-2 py-0.5 rounded-full bg-jj-red text-white">
                    {selectedEnvironment}
                  </span>
                  <span className="font-johnson-text text-xs text-jj-gray-05">Oracle → Snowflake</span>
                  {reportData.report_metadata?.total_schemas && (
                    <>
                      <span className="text-jj-gray-04 text-xs">·</span>
                      <span className="font-johnson-text text-xs text-jj-gray-05">
                        {reportData.report_metadata.total_schemas} schemas · {reportData.report_metadata.total_tables} tables
                      </span>
                    </>
                  )}
                  {reportData.report_metadata?.generated_timestamp && (
                    <>
                      <span className="text-jj-gray-04 text-xs">·</span>
                      <span className="font-johnson-text text-xs text-jj-gray-05 flex items-center gap-1">
                        <Icon src={clockIcon} alt="Time" className="w-3 h-3 text-jj-gray-04" />
                        {formatTimestamp(reportData.report_metadata.generated_timestamp)}
                      </span>
                    </>
                  )}
                </div>
              </div>
            </div>

            {/* Centre: Pass rate pill */}
            <div className="hidden md:flex items-center gap-3 flex-shrink-0">
              <div className="flex items-center gap-2 px-4 py-2 rounded-xl bg-jj-gray-01 border border-jj-gray-02">
                <div className="relative w-8 h-8 flex-shrink-0">
                  <svg className="w-8 h-8 -rotate-90" viewBox="0 0 32 32">
                    <circle cx="16" cy="16" r="13" fill="none" stroke="#e5e5e5" strokeWidth="3" />
                    <circle cx="16" cy="16" r="13" fill="none"
                      stroke={passRate >= 80 ? '#328714' : passRate >= 50 ? '#ff6017' : '#9e0000'}
                      strokeWidth="3"
                      strokeDasharray={`${passRate * 0.816} 81.6`}
                      strokeLinecap="round" />
                  </svg>
                  <span className="absolute inset-0 flex items-center justify-center font-johnson-text text-jj-gray-08 text-xs font-bold" style={{ fontSize: '9px' }}>
                    {passRate}%
                  </span>
                </div>
                <div>
                  <p className="font-johnson-text text-jj-gray-08 text-xs font-bold leading-none">{passRate}% Pass Rate</p>
                  <p className="font-johnson-text text-jj-gray-05 text-xs mt-0.5">{filteredSummary.total_passed}/{filteredSummary.total_tables_validated} tables</p>
                </div>
              </div>
            </div>

            {/* Right: Actions */}
            <div className="flex items-center gap-2 flex-shrink-0">
              <button
                onClick={handleLoadData}
                disabled={isLoading}
                aria-label="Refresh data"
                className="h-9 px-3 rounded-lg font-johnson-text text-xs font-bold flex items-center gap-1.5 text-jj-gray-07 bg-jj-gray-01 border border-jj-gray-03 hover:bg-jj-gray-08 hover:text-white hover:border-jj-gray-08 transition-all duration-150 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <Icon src={refreshIcon} alt="Refresh" className={`w-3.5 h-3.5 text-jj-gray-06 ${isLoading ? 'animate-spin' : ''}`} />
                <span className="hidden sm:inline">Refresh</span>
              </button>
              <button
                onClick={() => { setShowWelcome(true); setReportData(null); setSearchTerm(''); setStatusFilter(STATUS.ALL); setSelectedL0Schema(''); setSelectedL1Schema(''); setCurrentPage(1); }}
                aria-label="Change environment"
                className="h-9 px-3 rounded-lg font-johnson-text text-xs font-bold flex items-center gap-1.5 text-jj-gray-07 bg-jj-gray-01 border border-jj-gray-03 hover:bg-jj-gray-08 hover:text-white hover:border-jj-gray-08 transition-all duration-150"
              >
                <Icon src={databaseIcon} alt="Env" className="w-3.5 h-3.5 text-jj-gray-06" />
                <span className="hidden sm:inline">Environment</span>
              </button>
            </div>
          </div>
        </header>

        {/* ── CONTENT ─────────────────────────────────────────────────── */}
        <main className="flex-1 px-6 py-5 space-y-4">

          {/* Stats row */}
          <div className="grid grid-cols-3 sm:grid-cols-6 gap-3">
            {[
              { title: 'Total',     value: filteredSummary.total_tables_validated, icon: activityIcon,      colorClass: 'text-jj-gray-08',    accentClass: 'bg-jj-gray-05' },
              { title: 'Passed',    value: filteredSummary.total_passed,            icon: checkCircleIcon,   colorClass: 'text-jj-green-03',   accentClass: 'bg-jj-green-03' },
              { title: 'Critical',  value: filteredSummary.total_critical,          icon: xCircleIcon,       colorClass: 'text-jj-maroon-05',  accentClass: 'bg-jj-maroon-05' },
              { title: 'Faulty',    value: filteredSummary.total_faulty,            icon: alertTriangleIcon, colorClass: 'text-jj-orange-03',  accentClass: 'bg-jj-orange-03' },
              { title: 'Errors',    value: filteredSummary.total_errors,            icon: xCircleIcon,       colorClass: 'text-jj-maroon-05',  accentClass: 'bg-jj-maroon-05' },
              { title: 'Not Found', value: filteredSummary.total_not_found,         icon: alertTriangleIcon, colorClass: 'text-jj-gray-06',    accentClass: 'bg-jj-gray-04' },
            ].map((card, idx) => (
              <SummaryCard key={idx} {...card} />
            ))}
          </div>

          {/* Toolbar */}
          <div className="bg-white rounded-2xl border border-jj-gray-02 overflow-hidden" style={{ boxShadow: '0 1px 3px rgba(0,0,0,0.05)' }}>
            {/* Row 1: search + page size + clear */}
            <div className="flex items-center gap-2 px-3 py-2.5 border-b border-jj-gray-02">
              <div className="relative flex-1">
                <Icon src={searchIcon} alt="Search" className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-jj-gray-04 pointer-events-none" />
                <input
                  ref={searchInputRef}
                  type="text"
                  placeholder="Search tables…   Ctrl+F"
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  aria-label="Search tables"
                  className="w-full pl-9 pr-8 py-2 rounded-lg font-johnson-text text-sm text-jj-gray-08 bg-jj-gray-01 border border-jj-gray-02 outline-none focus:border-jj-gray-05 transition-colors duration-150"
                />
                {isSearching && (
                  <div className="absolute right-3 top-1/2 -translate-y-1/2">
                    <Icon src={activityIcon} alt="Searching" className="w-3.5 h-3.5 text-jj-gray-04 animate-spin" />
                  </div>
                )}
              </div>
              <div className="flex items-center gap-1.5 flex-shrink-0">
                <span className="font-johnson-text text-xs text-jj-gray-05">Show</span>
                <select
                  value={pageSize}
                  onChange={handlePageSizeChange}
                  className="py-2 px-2.5 rounded-lg font-johnson-text text-xs font-bold bg-jj-gray-01 border border-jj-gray-02 text-jj-gray-08 outline-none cursor-pointer"
                >
                  {[25, 50, 100, 200].map(n => <option key={n} value={n}>{n}</option>)}
                </select>
              </div>
              {activeFilters > 0 && (
                <button
                  onClick={clearAll}
                  className="flex items-center gap-1.5 px-3 py-2 rounded-lg font-johnson-text text-xs font-bold bg-jj-red text-white hover:bg-jj-maroon-05 transition-colors duration-150 flex-shrink-0"
                >
                  <Icon src={xCircleIcon} alt="Clear" className="w-3.5 h-3.5 brightness-0 invert" />
                  Clear {activeFilters}
                </button>
              )}
            </div>
            {/* Row 2: filter dropdowns */}
            <div className="flex items-center gap-0 divide-x divide-jj-gray-02">
              {[
                {
                  label: 'L0 Schema',
                  value: selectedL0Schema,
                  onChange: (v) => { setSelectedL0Schema(v); setCurrentPage(1); },
                  options: availableL0Schemas,
                  placeholder: 'All L0 Schemas',
                  disabled: !!selectedL1Schema,
                },
                {
                  label: 'L1 Schema',
                  value: selectedL1Schema,
                  onChange: (v) => { setSelectedL1Schema(v); setCurrentPage(1); },
                  options: availableL1Schemas,
                  placeholder: 'All L1 Schemas',
                  disabled: !!selectedL0Schema,
                },
                {
                  label: 'Status',
                  value: statusFilter,
                  onChange: (v) => { setStatusFilter(v); setCurrentPage(1); },
                  options: null,
                  placeholder: null,
                  disabled: false,
                },
              ].map(({ label, value, onChange, options, placeholder, disabled }) => (
                <div key={label} className="flex-1 flex items-center gap-2 px-4 py-2.5 min-w-0">
                  <span className={`font-johnson-text text-xs font-bold uppercase tracking-wider flex-shrink-0 w-16 ${disabled ? 'text-jj-gray-03' : 'text-jj-gray-05'}`}>{label}</span>
                  {options !== null ? (
                    <select
                      value={value}
                      onChange={(e) => onChange(e.target.value)}
                      disabled={disabled}
                      className={`flex-1 min-w-0 py-1.5 px-2.5 rounded-lg font-johnson-text text-xs font-bold border outline-none transition-colors duration-150 truncate
                        ${disabled ? 'bg-jj-gray-01 border-jj-gray-02 text-jj-gray-03 cursor-not-allowed opacity-50' : value ? 'bg-red-50 border-jj-red text-jj-red cursor-pointer' : 'bg-jj-gray-01 border-jj-gray-02 text-jj-gray-08 hover:border-jj-gray-05 cursor-pointer'}`}
                    >
                      <option value="">{placeholder}</option>
                      {options.map(o => <option key={o} value={o}>{o}</option>)}
                    </select>
                  ) : (
                    <select
                      value={statusFilter}
                      onChange={(e) => { setStatusFilter(e.target.value); setCurrentPage(1); }}
                      className={`flex-1 min-w-0 py-1.5 px-2.5 rounded-lg font-johnson-text text-xs font-bold border outline-none cursor-pointer transition-colors duration-150
                        ${statusFilter !== STATUS.ALL ? 'bg-red-50 border-jj-red text-jj-red' : 'bg-jj-gray-01 border-jj-gray-02 text-jj-gray-08 hover:border-jj-gray-05'}`}
                    >
                      <option value={STATUS.ALL}>All Statuses</option>
                      <option value={STATUS.PASSED}>Passed</option>
                      <option value={STATUS.CRITICAL}>Critical</option>
                      <option value={STATUS.ERROR}>Error</option>
                      <option value={STATUS.FAULTY}>Faulty</option>
                      <option value={STATUS.TIMEOUT}>Timeout</option>
                      <option value={STATUS.TABLE_NOT_FOUND}>Not Found</option>
                    </select>
                  )}
                </div>
              ))}
            </div>
          </div>

          {/* Table card */}
          <div className="bg-white rounded-2xl overflow-hidden border border-jj-gray-02" style={{ boxShadow: '0 1px 3px rgba(0,0,0,0.06), 0 4px 16px rgba(0,0,0,0.04)' }}>

            {/* Table header bar */}
            <div className="flex items-center justify-between px-5 py-3 border-b border-jj-gray-02">
              <div className="flex items-center gap-2">
                <Icon src={databaseIcon} alt="Tables" className="w-4 h-4 text-jj-gray-05" />
                <span className="font-johnson-text text-sm font-bold text-jj-gray-08">Tables</span>
                <span className="font-johnson-text text-xs px-2 py-0.5 rounded-full bg-jj-gray-01 text-jj-gray-06 font-bold">
                  {filteredTables.length.toLocaleString()}
                </span>
              </div>
              {filteredTables.length > 0 && (
                <PaginationControls
                  currentPage={currentPage}
                  totalPages={totalPages}
                  pageSize={pageSize}
                  totalItems={filteredTables.length}
                  onPageChange={handlePageChange}
                  onPageSizeChange={handlePageSizeChange}
                  showPageSize={false}
                />
              )}
            </div>

            <div className="overflow-x-auto">
              <table className="w-full font-johnson-text text-sm border-collapse">
                <thead>
                  <tr style={{ background: '#f9f9fb' }}>
                    <th className="px-5 py-3 text-left text-xs font-bold text-jj-gray-05 uppercase tracking-wider whitespace-nowrap min-w-[220px]">L0 Table</th>
                    <th className="px-5 py-3 text-left text-xs font-bold text-jj-gray-05 uppercase tracking-wider whitespace-nowrap min-w-[220px]">L1 Table</th>
                    <th className="px-5 py-3 text-center text-xs font-bold text-jj-gray-05 uppercase tracking-wider whitespace-nowrap min-w-[110px]">Status</th>
                    <th className="px-5 py-3 text-center text-xs font-bold text-jj-gray-05 uppercase tracking-wider whitespace-nowrap min-w-[100px]">L0 Rows</th>
                    <th className="px-5 py-3 text-center text-xs font-bold text-jj-gray-05 uppercase tracking-wider whitespace-nowrap min-w-[100px]">L1 Rows</th>
                    <th className="px-5 py-3 text-center text-xs font-bold text-jj-gray-05 uppercase tracking-wider whitespace-nowrap min-w-[160px]">Last Validated</th>
                    <th className="px-5 py-3 text-center text-xs font-bold text-jj-gray-05 uppercase tracking-wider whitespace-nowrap min-w-[120px]">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {paginatedTables.map((table) => (
                    <TableRow
                      key={table.table_name}
                      table={table}
                      onSelect={handleTableSelect}
                      onRefresh={handleRefreshTable}
                      refreshingTable={refreshingTable}
                    />
                  ))}
                </tbody>
              </table>
            </div>

            {filteredTables.length === 0 && (
              <div className="flex flex-col items-center justify-center py-20 px-6">
                <div className="w-16 h-16 rounded-2xl bg-jj-gray-01 flex items-center justify-center mb-4">
                  <Icon src={databaseIcon} alt="Empty" className="w-8 h-8 text-jj-gray-04" />
                </div>
                <p className="font-johnson-display text-lg text-jj-gray-07 mb-1" style={{ lineHeight: '120%' }}>{emptyState.title}</p>
                <p className="font-johnson-text text-sm text-jj-gray-05 text-center max-w-sm">{emptyState.message}</p>
                {emptyState.action && (
                  <p className="font-johnson-text text-xs text-jj-gray-04 mt-2">{emptyState.action}</p>
                )}
              </div>
            )}

            {filteredTables.length > 0 && (
              <div className="border-t border-jj-gray-02 px-5 py-3">
                <PaginationControls
                  currentPage={currentPage}
                  totalPages={totalPages}
                  pageSize={pageSize}
                  totalItems={filteredTables.length}
                  onPageChange={handlePageChange}
                  onPageSizeChange={handlePageSizeChange}
                  showPageSize={false}
                />
              </div>
            )}
          </div>

          <p className="font-johnson-text text-xs text-jj-gray-04 text-center pb-2">
            © {new Date().getFullYear()} Johnson &amp; Johnson · Confidential · For Internal Use Only
          </p>
        </main>

        {selectedTable && (
          <TableDetailModal table={selectedTable} onClose={() => setSelectedTable(null)} />
        )}
        {toast && (
          <Toast message={toast.message} type={toast.type} onClose={() => setToast(null)} />
        )}
      </div>
    </ErrorBoundary>
  );
}

export default DataTypeValidation;