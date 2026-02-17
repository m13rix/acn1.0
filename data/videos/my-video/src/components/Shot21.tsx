import {
	AbsoluteFill,
	interpolate,
	useCurrentFrame,
	useVideoConfig,
	Img,
	staticFile,
	Audio,
} from 'remotion';
import React from 'react';

export const Shot21: React.FC = () => {
	const frame = useCurrentFrame();
	const {durationInFrames} = useVideoConfig();

	// Timeline scaling: 9.1s total
	// Original: 0-8s (Approach), 8-12s (Ring) -> 8/12 = 2/3 ratio
	const splitFrame = Math.round((8 / 12) * durationInFrames);

	// 1. Approach Animation (Zoom and Fog)
	const approachScale = interpolate(frame, [0, splitFrame], [1, 1.2], {
		extrapolateRight: 'clamp',
	});
	const fogOpacity = interpolate(frame, [0, splitFrame], [0.4, 0.7]);

	// 2. Ring Overlay (Uncertainty)
	// We'll use a blurred overlay of wedding_rings.png if available or just a visual hint
	const ringOpacity = interpolate(frame, [splitFrame, splitFrame + 20], [0, 1], {
		extrapolateLeft: 'clamp',
		extrapolateRight: 'clamp',
	});

	// Text Overlay 'Восстановление возможно'
	const textOpacity = interpolate(frame, [splitFrame + 15, splitFrame + 30], [0, 1], {
		extrapolateLeft: 'clamp',
	});

	return (
		<AbsoluteFill style={{backgroundColor: '#1a1d1a'}}>
			{/* Segment 1: Woman in Fog */}
			<AbsoluteFill
				style={{
					transform: `scale(${approachScale})`,
				}}
			>
				<Img
					src={staticFile('woman_returning.png')}
					style={{
						width: '100%',
						height: '100%',
						objectFit: 'cover',
						filter: 'sepia(0.1) brightness(0.9)',
					}}
				/>
			</AbsoluteFill>

			{/* Fog Layer */}
			<AbsoluteFill
				style={{
					background: 'linear-gradient(to top, rgba(255,255,255,0.2), transparent)',
					opacity: fogOpacity,
					pointerEvents: 'none',
				}}
			/>

			{/* Segment 2: Blurred Ring Foreground */}
			<AbsoluteFill style={{opacity: ringOpacity}}>
				<div 
					className="absolute bottom-0 right-0 w-full h-full"
					style={{
						background: 'radial-gradient(circle at 80% 80%, rgba(255,255,255,0.1) 0%, transparent 40%)',
					}}
				/>
				<Img
					src={staticFile('wedding_rings.png')}
					style={{
						position: 'absolute',
						bottom: -100,
						right: -100,
						width: '60%',
						height: '60%',
						objectFit: 'contain',
						filter: 'blur(10px) brightness(0.7)',
						transform: 'rotate(-15deg)',
					}}
				/>
			</AbsoluteFill>

			{/* Overlay Text */}
			<AbsoluteFill className="justify-center items-center">
				<div 
					className="bg-black/40 backdrop-blur-md px-12 py-6 rounded-full border border-white/20"
					style={{opacity: textOpacity}}
				>
					<h2 
						className="text-white text-6xl font-light tracking-widest uppercase"
						style={{fontFamily: 'Inter, sans-serif', textShadow: '0 0 20px rgba(255,255,255,0.5)'}}
					>
						Восстановление возможно
					</h2>
				</div>
			</AbsoluteFill>

			<Audio src={staticFile('shot21_voice.mp3')} />
		</AbsoluteFill>
	);
};
