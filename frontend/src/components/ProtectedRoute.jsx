import React from 'react';
import { Navigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { isSessionEnding, saveReturnPath } from '../utils/sessionKeys';

const Spinner = ({ message }) => (
  <div className="flex items-center justify-center min-h-screen bg-jj-gray-01">
    <div className="text-center">
      <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-jj-red mx-auto"></div>
      <p className="mt-4 text-jj-gray-07 font-johnson-text">{message}</p>
    </div>
  </div>
);

const ProtectedRoute = ({ children }) => {
  const { authenticated, loading } = useAuth();

  // Show loading spinner while checking authentication
  if (loading) {
    return <Spinner message="Verifying authentication..." />;
  }

  if (!authenticated) {
    if (isSessionEnding()) {
      return <Spinner message="Signing out..." />;
    }
    saveReturnPath();
    return <Navigate to="/login" replace />;
  }

  // User is authenticated, render the protected content
  return children;
};

export default ProtectedRoute;