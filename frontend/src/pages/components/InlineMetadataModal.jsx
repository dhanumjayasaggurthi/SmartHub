import React from 'react';

const InlineMetadataModal = ({ metadata, loading, error, onClose }) => {
  if (loading) {
    return (
      <div style={{
        margin: '0.5rem 0',
        padding: '0.75rem',
        backgroundColor: '#f1efed',
        border: '1px solid #e8e6e3',
        borderRadius: '0.375rem'
      }}>
        <div style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: '0.5rem'
        }}>
          <div style={{
            width: '1rem',
            height: '1rem',
            border: '2px solid #e8e6e3',
            borderTopColor: '#0f68b2',
            borderRadius: '50%',
            animation: 'spin 1s linear infinite'
          }}></div>
          {/* COMPLIANT: Johnson Text Regular for body copy */}
          <span style={{ color: '#81766f', fontSize: '0.875rem', fontFamily: 'JohnsonText, sans-serif', lineHeight: '120%' }}>Loading metadata...</span>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div style={{
        margin: '0.5rem 0',
        padding: '0.75rem',
        backgroundColor: '#fef2f2',
        border: '1px solid #fecaca',
        borderRadius: '0.375rem'
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'start' }}>
          <div>
            {/* COMPLIANT: Johnson Display Regular for error headline (no bold) */}
            <p style={{ margin: 0, color: '#eb1700', fontWeight: '400', fontSize: '0.875rem', fontFamily: 'JohnsonDisplay, sans-serif', lineHeight: '110%' }}>Error loading metadata</p>
            <p style={{ margin: '0.25rem 0 0 0', fontSize: '0.75rem', color: '#991b1b', fontFamily: 'JohnsonText, sans-serif', lineHeight: '120%' }}>{error}</p>
          </div>
          <button
            onClick={onClose}
            style={{
              background: 'none',
              border: 'none',
              fontSize: '1rem',
              color: '#81766f',
              cursor: 'pointer',
              padding: '0'
            }}
          >
            ✕
          </button>
        </div>
      </div>
    );
  }

  if (!metadata || metadata.length === 0) {
    return (
      <div style={{
        margin: '0.5rem 0',
        padding: '0.75rem',
        backgroundColor: '#fffbeb',
        border: '1px solid #fde68a',
        borderRadius: '0.375rem'
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'start' }}>
          <div>
            {/* COMPLIANT: Johnson Display Regular for headline (no bold) */}
            <p style={{ margin: 0, color: '#92400e', fontWeight: '400', fontSize: '0.875rem', fontFamily: 'JohnsonDisplay, sans-serif', lineHeight: '110%' }}>No metadata found</p>
            <p style={{ margin: '0.25rem 0 0 0', fontSize: '0.75rem', color: '#78350f', fontFamily: 'JohnsonText, sans-serif', lineHeight: '120%' }}>
              This view may not have metadata registered in the catalog.
            </p>
          </div>
          <button
            onClick={onClose}
            style={{
              background: 'none',
              border: 'none',
              fontSize: '1rem',
              color: '#81766f',
              cursor: 'pointer',
              padding: '0'
            }}
          >
            ✕
          </button>
        </div>
      </div>
    );
  }

  return (
    <div style={{
      margin: '0.5rem 0',
      padding: '0.75rem',
      backgroundColor: '#ffffff',
      border: '2px solid #0f68b2',
      borderRadius: '0.375rem',
      boxShadow: '0 2px 4px rgba(0, 0, 0, 0.1)'
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem' }}>
        <div>
          {/* COMPLIANT: Johnson Display Regular for headline (no bold) */}
          <h4 style={{ margin: 0, fontSize: '0.875rem', fontWeight: '400', color: '#312c2a', fontFamily: 'JohnsonDisplay, sans-serif', lineHeight: '110%' }}>
            📊 Metadata ({metadata.length})
          </h4>
        </div>
        <button
          onClick={onClose}
          style={{
            background: 'none',
            border: 'none',
            fontSize: '1.25rem',
            color: '#81766f',
            cursor: 'pointer',
            padding: '0',
            lineHeight: 1
          }}
          title="Close metadata"
        >
          ✕
        </button>
      </div>

      <div style={{
        maxHeight: '250px',
        overflowY: 'auto',
        display: 'flex',
        flexDirection: 'column',
        gap: '0.5rem'
      }}>
        {metadata.map((item, index) => (
          <MetadataCard key={index} metadata={item} />
        ))}
      </div>

      <style>{`
        @keyframes spin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
      `}</style>
    </div>
  );
};

const MetadataCard = ({ metadata }) => {
  const hasDescriptionMatches = metadata.description_matches && metadata.description_matches.length > 0;
  const hasTags = metadata.tags && metadata.tags.length > 0;
  const hasCategories = metadata.categories && metadata.categories.length > 0;
  const hasDescription = metadata.description && metadata.description.trim() !== '';

  return (
    <div style={{
      padding: '0.5rem',
      backgroundColor: '#f1efed',
      border: '1px solid #e8e6e3',
      borderRadius: '0.25rem'
    }}>
      {/* Header */}
      <div style={{ marginBottom: '0.5rem' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          {/* COMPLIANT: Johnson Display Regular for card headline (no bold) */}
          <h5 style={{ margin: 0, fontSize: '0.875rem', fontWeight: '400', color: '#312c2a', fontFamily: 'JohnsonDisplay, sans-serif', lineHeight: '110%' }}>
            {metadata.name || 'Unnamed view'}
          </h5>
          <span style={{
            padding: '0.125rem 0.375rem',
            backgroundColor: '#dbeafe',
            color: '#1e40af',
            borderRadius: '9999px',
            fontSize: '0.625rem',
            fontWeight: '400',
            fontFamily: 'JohnsonText, sans-serif'
          }}>
            View
          </span>
        </div>
        {metadata.id && (
          <p style={{ margin: '0.125rem 0 0 0', fontSize: '0.625rem', color: '#81766f', fontFamily: 'monospace' }}>
            ID: {metadata.id}
          </p>
        )}
      </div>

      {/* Description - Only show if exists */}
      {hasDescription && (
        <div style={{
          marginBottom: '0.5rem',
          padding: '0.5rem',
          backgroundColor: '#ffffff',
          borderRadius: '0.25rem',
          fontSize: '0.75rem',
          color: '#6e6259',
          border: '1px solid #e8e6e3',
          fontFamily: 'JohnsonText, sans-serif',
          lineHeight: '120%'
        }}>
          {metadata.description}
        </div>
      )}

      {/* Combined Database & Metrics Information */}
      <div style={{
        marginBottom: '0.5rem',
        padding: '0.5rem',
        backgroundColor: '#eff6ff',
        borderRadius: '0.25rem',
        border: '1px solid #bfdbfe'
      }}>
        {/* COMPLIANT: Johnson Display Regular for section header (no bold) */}
        <h6 style={{ margin: '0 0 0.25rem 0', fontSize: '0.75rem', fontWeight: '400', color: '#0f68b2', fontFamily: 'JohnsonDisplay, sans-serif', lineHeight: '110%' }}>
          Database & metrics
        </h6>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '0.25rem', fontSize: '0.75rem', fontFamily: 'JohnsonText, sans-serif' }}>
          <InfoRow label="Database" value={metadata.database_name} />
          <InfoRow label="DB ID" value={metadata.database_id} />
          <InfoRow label="Score" value={metadata.score ? `${metadata.score.toFixed(2)}%` : 'N/A'} />
          <InfoRow label="Fields" value={metadata.matched_fields !== undefined ? metadata.matched_fields : 'N/A'} />
          <InfoRow label="Tagged" value={metadata.matched_fields_tagged !== undefined ? metadata.matched_fields_tagged : 'N/A'} />
          <InfoRow label="Custom" value={metadata.matched_custom_properties !== undefined ? metadata.matched_custom_properties : 'N/A'} />
        </div>
      </div>

      {/* Description Matches - Only show if data exists */}
      {hasDescriptionMatches && (
        <div style={{
          marginBottom: '0.5rem',
          padding: '0.5rem',
          backgroundColor: '#dcfce7',
          borderRadius: '0.25rem',
          border: '1px solid #bbf7d0'
        }}>
          {/* COMPLIANT: Johnson Display Regular for section header (no bold) */}
          <h6 style={{ margin: '0 0 0.25rem 0', fontSize: '0.75rem', fontWeight: '400', color: '#15803d', fontFamily: 'JohnsonDisplay, sans-serif', lineHeight: '110%' }}>
            Matches ({metadata.description_matches.length})
          </h6>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
            {metadata.description_matches.map((match, matchIndex) => (
              <div key={matchIndex} style={{
                padding: '0.25rem',
                backgroundColor: '#f0fdf4',
                borderRadius: '0.25rem',
                fontSize: '0.625rem',
                border: '1px solid #bbf7d0',
                fontFamily: 'JohnsonText, sans-serif',
                lineHeight: '120%'
              }}>
                {/* COMPLIANT: Using Johnson Text Medium (weight 500) instead of bold (700) */}
                <div style={{ fontWeight: '500', color: '#15803d' }}>
                  "{match.tokenText}" (pos: {match.startOffset}-{match.endOffset})
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Tags - Only show if data exists */}
      {hasTags && (
        <div style={{
          marginBottom: '0.5rem',
          padding: '0.5rem',
          backgroundColor: '#eff6ff',
          borderRadius: '0.25rem',
          border: '1px solid #bfdbfe'
        }}>
          {/* COMPLIANT: Johnson Display Regular for section header (no bold) */}
          <h6 style={{ margin: '0 0 0.25rem 0', fontSize: '0.75rem', fontWeight: '400', color: '#6e6259', fontFamily: 'JohnsonDisplay, sans-serif', lineHeight: '110%' }}>
            Tags ({metadata.tags.length})
          </h6>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.25rem' }}>
            {metadata.tags.map((tag, tagIndex) => (
              <span key={tagIndex} style={{
                padding: '0.125rem 0.375rem',
                backgroundColor: '#dbeafe',
                color: '#1e40af',
                borderRadius: '0.25rem',
                fontSize: '0.625rem',
                border: '1px solid #bfdbfe',
                fontFamily: 'JohnsonText, sans-serif'
              }}>
                {typeof tag === 'string' ? tag : tag.name || 'Tag'}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Categories - Only show if data exists */}
      {hasCategories && (
        <div style={{
          padding: '0.5rem',
          backgroundColor: '#f0fdf4',
          borderRadius: '0.25rem',
          border: '1px solid #bbf7d0'
        }}>
          {/* COMPLIANT: Johnson Display Regular for section header (no bold) */}
          <h6 style={{ margin: '0 0 0.25rem 0', fontSize: '0.75rem', fontWeight: '400', color: '#6e6259', fontFamily: 'JohnsonDisplay, sans-serif', lineHeight: '110%' }}>
            Categories ({metadata.categories.length})
          </h6>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.25rem' }}>
            {metadata.categories.map((category, catIndex) => (
              <span key={catIndex} style={{
                padding: '0.125rem 0.375rem',
                backgroundColor: '#d1fae5',
                color: '#065f46',
                borderRadius: '0.25rem',
                fontSize: '0.625rem',
                border: '1px solid #a7f3d0',
                fontFamily: 'JohnsonText, sans-serif'
              }}>
                {typeof category === 'string' ? category : category.name || 'Category'}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};

const InfoRow = ({ label, value }) => (
  <div style={{ display: 'flex', justifyContent: 'space-between', gap: '0.25rem' }}>
    <span style={{ fontWeight: '400', color: '#6e6259', fontSize: '0.7rem', fontFamily: 'JohnsonText, sans-serif', lineHeight: '120%' }}>{label}:</span>
    <span style={{ color: '#81766f', textAlign: 'right', fontSize: '0.7rem', fontFamily: 'JohnsonText, sans-serif', lineHeight: '120%' }}>{value || 'N/A'}</span>
  </div>
);

export default InlineMetadataModal;