import {
	AbsoluteFill,
	interpolate,
	useCurrentFrame,
	useVideoConfig,
	Img,
	staticFile,
	Audio,
	Easing,
} from 'remotion';
import {Video} from '@remotion/media';
import React from 'react';

export const Shot22: React.FC = () => {
	const frame = useCurrentFrame();
	const {durationInFrames} = useVideoConfig();

	// Timeline scaling: 5.57s total
	// Segments: 0-5s scaled
	
	// 1. Paper Aging Rapidly (simulate with contrast/sepia/blur change)
	const ageProgress = interpolate(frame, [0, durationInFrames], [0, 1], {
		easing: Easing.out(Easing.quad),
	});

	const sepia = interpolate(ageProgress, [0, 1], [0, 0.6]);
	const contrast = interpolate(ageProgress, [0, 1], [1, 1.4]);
	const blur = interpolate(ageProgress, [0, 0.5, 1], [0, 1, 0]);

	// 2. Red Stamp VOID appears (around 3s original, scaled)
	const stampStart = Math.round((3 / 5) * durationInFrames);
	const stampOpacity = interpolate(frame, [stampStart, stampStart + 5], [0, 1], {
		extrapolateLeft: 'clamp',
	});
	const stampScale = interpolate(frame, [stampStart, stampStart + 5], [2, 1], {
		extrapolateLeft: 'clamp',
		easing: Easing.out(Easing.back(1.5)),
	});

	// 3. Dramatic zoom into stamp (starts after stamp appearance)
	const zoomProgress = interpolate(frame, [stampStart + 10, durationInFrames], [0, 1], {
		extrapolateLeft: 'clamp',
		easing: Easing.in(Easing.quad),
	});
	const zoomScale = interpolate(zoomProgress, [0, 1], [1, 2]);

	return (
		<AbsoluteFill style={{backgroundColor: '#e6d5b8'}}>
			{/* Main Document with Aging and Zoom */}
			<AbsoluteFill
				style={{
					transform: `scale(${zoomScale})`,
					filter: `sepia(${sepia}) contrast(${contrast}) blur(${blur}px)`,
				}}
			>
				<Img
					src={staticFile('document_void.png')}
					style={{
						width: '100%',
						height: '100%',
						objectFit: 'cover',
					}}
				/>
			</AbsoluteFill>

			{/* Stamp Overlay (if separate, but usually in the image)
			    Since instruction says "red stamp VOID appears", and we have document_void.png, 
				the image likely contains the stamp. We'll simulate its "appearance" with an overlay 
				if the base image is just the document, or use the base image and animate its visibility.
				Assuming document_void.png has the stamp, we'll use a mask or just fade the whole image in over a blank one?
				Actually, I'll use a red "VOID" text overlay for the "appearance" part to make it dramatic.
			*/}
			<AbsoluteFill className="justify-center items-center">
				<div
					style={{
						opacity: stampOpacity,
						transform: `scale(${stampScale}) rotate(-15deg)`,
						border: '10px solid #cc0000',
						padding: '20px 40px',
						color: '#cc0000',
						fontSize: 150,
						fontWeight: 900,
						fontFamily: 'Inter, sans-serif',
						textTransform: 'uppercase',
						backgroundColor: 'rgba(255,255,255,0.1)',
						boxShadow: '0 0 20px rgba(204,0,0,0.3)',
						borderRadius: 10,
						letterSpacing: 20,
					}}
				>
					VOID
				</div>
			</AbsoluteFill>

			{/* Dust Particles Overlay */}
			<AbsoluteFill style={{opacity: 0.3, pointerEvents: 'none', mixBlendMode: 'multiply'}}>
				<Video
					src={staticFile('dust_particles.mp4')}
					style={{
						width: '100%',
						height: '100%',
						objectFit: 'cover',
					}}
					muted
					loop
				/>
			</AbsoluteFill>

			{/* Vignette */}
			<AbsoluteFill
				style={{
					background: 'radial-gradient(circle, transparent 50%, rgba(0,0,0,0.5) 100%)',
					pointerEvents: 'none',
				}}
			/>

			<Audio src={staticFile('shot22_voice.mp3')} />
		</AbsoluteFill>
	);
};
