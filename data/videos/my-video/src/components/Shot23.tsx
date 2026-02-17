import {
	AbsoluteFill,
	interpolate,
	useCurrentFrame,
	useVideoConfig,
	Img,
	staticFile,
	Audio,
	Easing,
	random,
} from 'remotion';
import React from 'react';

export const Shot23: React.FC = () => {
	const frame = useCurrentFrame();
	const {durationInFrames} = useVideoConfig();

	// Timeline scaling: 6.29s total
	// Eraser movement: Zig-zag erasing from top to bottom
	// Mask reveal (or hide) logic
	
	const eraseProgress = interpolate(frame, [0, durationInFrames], [0, 100], {
		easing: Easing.linear,
	});

	// Surreal Particle Effect (simulated with random noise or dots)
	// We'll create a few floating particles that fade out
	const particles = new Array(20).fill(0).map((_, i) => {
		const seed = i * 132;
		const x = random(seed) * 100;
		const y = random(seed + 1) * 100;
		const delay = random(seed + 2) * durationInFrames * 0.8;
		
		const pFrame = frame - delay;
		const opacity = interpolate(pFrame, [0, 20], [1, 0], {
			extrapolateLeft: 'clamp',
			extrapolateRight: 'clamp',
		});
		const scale = interpolate(pFrame, [0, 20], [1, 0]);
		const lift = interpolate(pFrame, [0, 20], [0, -50]);

		if (pFrame < 0) return null;

		return (
			<div
				key={i}
				className="absolute bg-white rounded-full opacity-80"
				style={{
					left: `${x}%`,
					top: `${y}%`,
					width: 10 + random(seed + 3) * 10,
					height: 10 + random(seed + 3) * 10,
					opacity,
					transform: `translateY(${lift}px) scale(${scale})`,
				}}
			/>
		);
	});

	// Text Overlay
	const textOpacity = interpolate(frame, [durationInFrames - 40, durationInFrames - 10], [0, 1], {
		extrapolateLeft: 'clamp',
	});

	return (
		<AbsoluteFill style={{backgroundColor: '#e0e0e0'}}>
			{/* Original Drawing (Being Erased) */}
			<AbsoluteFill
				style={{
					// Reveal from bottom up effectively "erasing" from top down if we clip top
					// Or just use a clip-path moving down
					clipPath: `inset(${eraseProgress}% 0 0 0)`, 
				}}
			>
				<Img
					src={staticFile('eraser_wedding.png')}
					style={{
						width: '100%',
						height: '100%',
						objectFit: 'cover',
						filter: 'grayscale(1) contrast(1.2)', // Pencil sketch look
					}}
				/>
			</AbsoluteFill>

			{/* Eraser Head (Moving with the erasure line) */}
			<AbsoluteFill>
				<div 
					className="absolute w-full h-20 bg-white blur-xl opacity-50"
					style={{
						top: `${eraseProgress}%`,
						transform: 'translateY(-50%)',
					}}
				/>
			</AbsoluteFill>

			{/* Void/Empty Background underneath */}
			<AbsoluteFill style={{zIndex: -1, backgroundColor: '#111'}} />

			{/* Surreal Particles */}
			<AbsoluteFill>{particles}</AbsoluteFill>

			{/* Overlay Text */}
			<AbsoluteFill className="justify-center items-center">
				<div 
					className="bg-red-900/90 px-8 py-4 rounded shadow-2xl transform -rotate-2"
					style={{opacity: textOpacity}}
				>
					<h2 
						className="text-white text-5xl font-bold uppercase tracking-widest"
						style={{fontFamily: 'Inter, sans-serif'}}
					>
						Развод ≠ Недействительность
					</h2>
				</div>
			</AbsoluteFill>

			<Audio src={staticFile('shot23_voice.mp3')} />
		</AbsoluteFill>
	);
};
