import { useState, useEffect, useRef } from 'react';
import { useMsal } from '@azure/msal-react';
import { apiFetch } from '../utils/apiClient';

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL;
const NO_PHOTO = 'NONE'; // sentinel so we also cache "user has no photo" and skip re-asking Graph

function cacheKey(username) {
  return `profile_photo_${username}`;
}

export const useProfilePhoto = (user, onSessionExpired) => {
  const { instance, accounts } = useMsal();
  const [profilePhoto, setProfilePhoto] = useState(null);
  const [photoLoading, setPhotoLoading] = useState(true);
  const hasFetchedRef = useRef(false);
  const isFetchingRef = useRef(false);

  useEffect(() => {
    // Prevent duplicate fetches
    if (!user || accounts.length === 0 || hasFetchedRef.current || isFetchingRef.current) {
      if (!user || accounts.length === 0) {
        setPhotoLoading(false);
      }
      return;
    }

    // Already fetched this photo earlier in the session - use it, skip
    // the MSAL token + Graph API round trip entirely.
    const cached = sessionStorage.getItem(cacheKey(user.username));
    if (cached) {
      setProfilePhoto(cached === NO_PHOTO ? null : cached);
      setPhotoLoading(false);
      hasFetchedRef.current = true;
      return;
    }

    const fetchProfilePhoto = async () => {
      isFetchingRef.current = true;

      try {
        const account = accounts[0];
        if (!account) {
          setPhotoLoading(false);
          return;
        }

        // Validate account has necessary properties and is active
        if (!account.username || !account.homeAccountId || !account.idTokenClaims) {
          setPhotoLoading(false);
          return;
        }

        // Check if account is from a valid session
        const activeAccount = instance.getActiveAccount();
        if (!activeAccount || activeAccount.homeAccountId !== account.homeAccountId) {
          // No active session - session expired, trigger logout
          console.warn('Session expired - logging out user');
          if (onSessionExpired) {
            onSessionExpired();
          }
          setPhotoLoading(false);
          return;
        }

        let token;

        try {
          // Try to get token silently first
          const response = await instance.acquireTokenSilent({
            scopes: ["User.Read"],
            account: account
          });

          if (!response || !response.accessToken) {
            setPhotoLoading(false);
            return;
          }

          token = response.accessToken;
        } catch (silentError) {
          // If silent acquisition fails, try interactive popup
          if (silentError.name === 'InteractionRequiredAuthError' ||
              silentError.errorCode === 'interaction_required' ||
              silentError.message?.includes('AADSTS')) {

            console.log('Silent token acquisition failed, trying interactive login...');

            try {
              // Try interactive token acquisition
              const interactiveResponse = await instance.acquireTokenPopup({
                scopes: ["User.Read"],
                account: account
              });

              if (!interactiveResponse || !interactiveResponse.accessToken) {
                console.warn('Interactive token acquisition failed - session invalid');
                if (onSessionExpired) {
                  onSessionExpired();
                }
                setPhotoLoading(false);
                return;
              }

              token = interactiveResponse.accessToken;
            } catch (interactiveError) {
              // Interactive login failed - session is truly invalid
              console.warn('Session expired - user authentication required');
              if (onSessionExpired) {
                onSessionExpired();
              }
              setPhotoLoading(false);
              return;
            }
          } else {
            // Other error - just skip photo
            throw silentError;
          }
        }

        // Fetch profile photo from backend
        const photoResponse = await apiFetch(`/auth/user/photo`, {
          headers: {
            'Authorization': `Bearer ${token}`
          }
        });

        if (photoResponse.ok) {
          const blob = await photoResponse.blob();
          const dataUrl = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = reject;
            reader.readAsDataURL(blob);
          });
          sessionStorage.setItem(cacheKey(account.username), dataUrl);
          setProfilePhoto(dataUrl);
        } else if (photoResponse.status === 401 || photoResponse.status === 403) {
          // Unauthorized - session may be expired on backend
          console.warn('Backend authentication failed - session may be expired');
          if (onSessionExpired) {
            onSessionExpired();
          }
          setProfilePhoto(null);
        } else {
          // No photo available - this is normal, cache it so we don't ask again this session
          sessionStorage.setItem(cacheKey(account.username), NO_PHOTO);
          setProfilePhoto(null);
        }
      } catch (error) {
        // Silently handle all other authentication-related errors
        const isAuthError =
          error.name === 'InteractionRequiredAuthError' ||
          error.errorCode === 'interaction_required' ||
          error.name === 'BrowserAuthError' ||
          error.errorCode?.includes('popup_window_error') ||
          error.message?.includes('interaction_required') ||
          error.message?.includes('AADSTS');

        if (!isAuthError) {
          // Only log truly unexpected errors (not auth-related)
          console.warn('Profile photo fetch failed:', error.message || error);
        }

        setProfilePhoto(null);
      } finally {
        setPhotoLoading(false);
        hasFetchedRef.current = true;
        isFetchingRef.current = false;
      }
    };

    fetchProfilePhoto();
  }, [user?.username, accounts.length, instance, onSessionExpired]); // Use stable primitive values

  return { profilePhoto, photoLoading };
};