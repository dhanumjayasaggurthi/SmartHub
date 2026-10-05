import React, { useState } from 'react';

// Import your company icons - adjust paths as needed
import refreshIcon from "/icons/JJ_Icon_Refresh_RGB.svg";
import warningIcon from "/icons/JJ_Icon_Refresh_RGB.svg"; // Add your warning icon

// Import your loading spinner video
import loadingVideo from "/spinner.mp4"; // Update with your actual video path

// Streamlit Chatbot URL - Replace with your actual Streamlit app URL
const STREAMLIT_CHATBOT_URL = import.meta.env.VITE_API_RIMDOCS_URL;

// Icon component for consistent usage
const Icon = ({ src, alt, className = "w-4 h-4", style = {} }) => (
  <img
    src={src}
    alt={alt}
    className={className}
    style={{ filter: 'currentColor', ...style }}
  />
);

// Embedded Streamlit Chatbot component
const EmbeddedStreamlitChatbot = ({ streamlitUrl }) => {
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState(false);

  const handleIframeLoad = () => {
    setIsLoading(false);
    setError(false);
  };

  const handleIframeError = () => {
    setIsLoading(false);
    setError(true);
  };

  const handleOpenInNewTab = () => {
    window.open(streamlitUrl, '_blank', 'noopener,noreferrer');
  };

  return (
    <div className="h-full flex flex-col bg-jj-gray-01">
      {/* Content area - iframe and loading/error states */}
      <div className="flex-1 relative bg-jj-gray-01">
        {/* Iframe container - always rendered but hidden during loading */}
        <iframe
          src={streamlitUrl}
          className={`absolute inset-0 w-full h-full border-0 transition-opacity duration-300 ${
            isLoading ? 'opacity-0' : 'opacity-100'
          }`}
          title="GRADH AI assistant"
          onLoad={handleIframeLoad}
          onError={handleIframeError}
          allow="clipboard-read; clipboard-write"
          sandbox="allow-same-origin allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox"
          style={{ visibility: isLoading ? 'hidden' : 'visible' }}
        />

        {/* Loading indicator - overlays the iframe area */}
        {isLoading && !error && (
          <div className="absolute inset-0 flex items-center justify-center bg-jj-gray-01 z-10">
            <div className="text-center">
              {/* Circular video container */}
              <div className="w-32 h-32 mx-auto mb-4 rounded-full overflow-hidden shadow-lg">
                <video
                  autoPlay
                  loop
                  muted
                  playsInline
                  className="w-full h-full object-cover"
                  style={{ outline: 'none' }}
                >
                  <source src={loadingVideo} type="video/mp4" />
                  {/* Fallback to icon spinner if video doesn't load */}
                  <div className="w-full h-full flex items-center justify-center bg-jj-blue-03">
                    <Icon src={refreshIcon} alt="Loading" className="w-12 h-12 animate-spin" style={{ filter: 'brightness(0) invert(1)' }} />
                  </div>
                </video>
              </div>
              {/* COMPLIANT: Johnson Text Regular for body copy, sentence case */}
              <p className="text-jj-gray-07 font-johnson-text text-lg" style={{ lineHeight: '120%' }}>Loading GRADH AI assistant...</p>
              <p className="text-jj-gray-05 font-johnson-text text-sm mt-2" style={{ lineHeight: '120%' }}>Please wait while we connect to the service</p>
            </div>
          </div>
        )}

        {/* Error message - overlays the iframe area */}
        {error && (
          <div className="absolute inset-0 flex items-center justify-center bg-jj-gray-01 p-6 z-10">
            <div className="max-w-md w-full bg-white rounded-lg shadow-lg border border-jj-gray-03 p-8 text-center">
              <div className="w-16 h-16 bg-red-100 rounded-full flex items-center justify-center mx-auto mb-4">
                <Icon
                  src={warningIcon}
                  alt="Warning"
                  className="w-8 h-8"
                  style={{ filter: 'invert(27%) sepia(89%) saturate(6943%) hue-rotate(355deg) brightness(94%) contrast(116%)' }}
                />
              </div>
              {/* COMPLIANT: Johnson Display Regular for headline (no bold) */}
              <h2 className="text-xl font-johnson-display text-jj-gray-08 mb-3" style={{ lineHeight: '110%' }}>
                Unable to load chatbot
              </h2>
              {/* COMPLIANT: Johnson Text Regular for body copy */}
              <p className="text-jj-gray-06 font-johnson-text mb-6" style={{ lineHeight: '120%' }}>
                We couldn't load the Streamlit chatbot. This might be due to network issues or the chatbot being temporarily unavailable.
              </p>
              <div className="space-y-3">
                <button
                  onClick={() => window.location.reload()}
                  className="w-full px-4 py-2 bg-jj-red text-white rounded-md hover:bg-jj-maroon-05 transition-colors font-johnson-text flex items-center justify-center space-x-2"
                  style={{ outline: 'none' }}
                  onMouseDown={(e) => e.preventDefault()}
                >
                  <Icon src={refreshIcon} alt="Retry" className="w-4 h-4" style={{ filter: 'brightness(0) invert(1)' }} />
                  <span>Retry</span>
                </button>
                <button
                  onClick={handleOpenInNewTab}
                  className="w-full px-4 py-2 border border-jj-gray-03 text-jj-gray-07 rounded-md hover:bg-jj-gray-01 transition-colors font-johnson-text flex items-center justify-center space-x-2"
                  style={{ outline: 'none' }}
                  onMouseDown={(e) => e.preventDefault()}
                >
                  <span>Open in new tab</span>
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

// Main chatbot component - Shows embedded Streamlit chatbot
export default function AIchatbot() {
  return <EmbeddedStreamlitChatbot streamlitUrl={STREAMLIT_CHATBOT_URL} />;
}