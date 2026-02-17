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
import React from 'react';

export const Shot8: React.FC = () => {
	const frame = useCurrentFrame();
	const {durationInFrames} = useVideoConfig();

	// Timeline scaling: 6.29s total (189 frames)
	// Original split: 6s / 14s.
	// New split: approx 2.7s (81 frames)
	const splitFrame = Math.round((6 / 14) * durationInFrames);

	const isGavel = frame < splitFrame;
	const threadsFrame = frame - splitFrame;

	// Gavel Animation (Static or slow zoom)
	const gavelScale = interpolate(frame, [0, splitFrame], [1, 1.1], {
		extrapolateRight: 'clamp',
	});

	// Threads "Organizing" Animation
	// Simulate untangling: heavy blur + rotation + scale -> clean
	const threadsDuration = durationInFrames - splitFrame;
	
	const organizeProgress = interpolate(threadsFrame, [0, threadsDuration], [0, 1], {
		extrapolateLeft: 'clamp',
		extrapolateRight: 'clamp',
		easing: Easing.out(Easing.cubic),
	});

	const threadsBlur = interpolate(organizeProgress, [0, 1], [20, 0]);
	const threadsScale = interpolate(organizeProgress, [0, 1], [1.5, 1]);
	const threadsRotate = interpolate(organizeProgress, [0, 1], [10, 0]); // Slight untwist

	// Text Appearance (End)
	const textStart = durationInFrames - 45; // Last 1.5s
	const textOpacity = interpolate(frame, [textStart, textStart + 15], [0, 1], {
		extrapolateLeft: 'clamp',
		extrapolateRight: 'clamp',
	});

	return (
		<AbsoluteFill style={{backgroundColor: 'black'}}>
			{isGavel ? (
				<AbsoluteFill style={{overflow: 'hidden'}}>
					<Img
						src={staticFile('judge_gavel.png')}
						style={{
							width: '100%',
							height: '100%',
							objectFit: 'cover',
							transform: `scale(${gavelScale})`,
						}}
					/>
				</AbsoluteFill>
			) : (
				<AbsoluteFill style={{overflow: 'hidden', backgroundColor: '#111'}}>
					<Img
						src={staticFile('mental_threads.png')}
						style={{
							width: '100%',
							height: '100%',
							objectFit: 'cover',
							transform: `scale(${threadsScale}) rotate(${threadsRotate}deg)`,
							filter: `blur(${threadsBlur}px)`,
						}}
					/>
				</AbsoluteFill>
			)}

			{/* Courtroom Shadows Overlay (Blinds) */}
			<AbsoluteFill
				style={{
					background: 'repeating-linear-gradient(90deg, transparent, transparent 40px, rgba(0,0,0,0.5) 40px, rgba(0,0,0,0.5) 80px)',
					mixBlendMode: 'multiply',
					pointerEvents: 'none',
					opacity: 0.4,
				}}
			/>

			{/* Overlay Text */}
			<AbsoluteFill
				className="justify-center items-center"
				style={{opacity: textOpacity}}
			>
				<div
					className="bg-black/60 px-8 py-4 rounded-lg backdrop-blur-sm border border-white/10"
				>
					<h1
						className="text-white text-7xl font-bold uppercase tracking-wider"
						style={{
							fontFamily: 'Inter, sans-serif',
							textShadow: '0 2px 10px rgba(0,0,0,0.5)',
						}}
					>
						Решение суда
					</h1>
				</div>
			</AbsoluteFill>

			<Audio src={staticFile('shot8_voice.mp3')} />
		</AbsoluteFill>
	);
};
